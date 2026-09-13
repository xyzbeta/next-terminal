package env

import (
	"fmt"
	"time"

	"next-terminal/server/config"
	"next-terminal/server/model"

	"github.com/glebarez/sqlite"
	"gorm.io/driver/mysql"
	"gorm.io/gorm"
	"gorm.io/gorm/logger"
)

func setupDB() *gorm.DB {

	var logMode logger.Interface
	if config.GlobalCfg.Debug {
		logMode = logger.Default.LogMode(logger.Info)
	} else {
		logMode = logger.Default.LogMode(logger.Silent)
	}

	fmt.Printf("当前数据库模式为：%v\n", config.GlobalCfg.DB)
	var err error
	var db *gorm.DB
	if config.GlobalCfg.DB == "mysql" {
		dsn := fmt.Sprintf("%s:%s@tcp(%s:%d)/%s?charset=utf8mb4&parseTime=True&loc=Local&timeout=60s",
			config.GlobalCfg.Mysql.Username,
			config.GlobalCfg.Mysql.Password,
			config.GlobalCfg.Mysql.Hostname,
			config.GlobalCfg.Mysql.Port,
			config.GlobalCfg.Mysql.Database,
		)
		db, err = gorm.Open(mysql.Open(dsn), &gorm.Config{
			Logger: logMode,
		})
		if err == nil {
			sqlDB, _ := db.DB()
			if sqlDB != nil {
				sqlDB.SetMaxOpenConns(25)
				sqlDB.SetMaxIdleConns(10)
				// 连接最大存活/空闲时长：MySQL 服务端 wait_timeout（默认 8h）会单方面断开
				// 长连接，池中残留的死连接会在下次复用时抛 "invalid connection"，
				// 表现为偶发接口报错、刷新即恢复。主动回收早于服务端超时即可根除。
				sqlDB.SetConnMaxLifetime(3 * time.Hour)
				sqlDB.SetConnMaxIdleTime(30 * time.Minute)
			}
		}
	} else {
		// WAL：读写不再互斥；busy_timeout：并发写等待 5s 而非立即 SQLITE_BUSY；foreign_keys：外键约束
		//
		// synchronous(NORMAL)：WAL 模式下的官方推荐值。默认 FULL 会让每次 autocommit 都
		// 触发 fsync，而本进程只持有单条连接（见下方 SetMaxOpenConns(1)），fsync 期间
		// 所有请求都在池中排队——失败登录写日志、文件操作日志、窗口 resize 落库等
		// 高频小事务都会造成整站停顿。NORMAL 下仅断电可能丢失最后若干已提交事务，
		// 不会损坏数据库文件。
		dsn := fmt.Sprintf("file:%s?cache=shared&mode=rwc&_pragma=journal_mode(WAL)&_pragma=synchronous(NORMAL)&_pragma=busy_timeout(5000)&_pragma=foreign_keys(1)", config.GlobalCfg.Sqlite.File)
		db, err = gorm.Open(sqlite.Open(dsn), &gorm.Config{
			Logger:                 logMode,
			SkipDefaultTransaction: true,
		})
		if err == nil {
			sqlDB, _ := db.DB()
			if sqlDB != nil {
				// SQLite 单写者：限制为单连接，配合 busy_timeout 确定性排队，消除跨连接锁竞争
				sqlDB.SetMaxOpenConns(1)
				sqlDB.SetMaxIdleConns(1)
			}
		}
	}

	if err != nil {
		panic(fmt.Errorf("连接数据库异常: %v", err.Error()))
	}

	if err := db.AutoMigrate(&model.User{}, &model.Asset{}, &model.AssetAttribute{}, &model.Session{}, &model.Command{},
		&model.Credential{}, &model.Property{}, &model.UserGroup{}, &model.UserGroupMember{},
		&model.LoginLog{}, &model.Job{}, &model.JobLog{}, &model.AccessSecurity{}, &model.AccessGateway{},
		&model.Storage{}, &model.Strategy{},
		&model.AccessToken{}, &model.ShareSession{},
		&model.Role{}, &model.RoleMenuRef{}, &model.UserRoleRef{},
		&model.LoginPolicy{}, &model.LoginPolicyUserRef{}, &model.TimePeriod{},
		&model.StorageLog{}, &model.Authorised{}); err != nil {
		panic(fmt.Errorf("初始化数据库表结构异常: %v", err.Error()))
	}

	// 存量库索引迁移：GORM AutoMigrate 不会为已存在的表新增索引，需幂等补齐
	//
	// 注意这里必须手工补齐而不能依赖 model tag——GORM 的 tag 分隔符是分号，
	// 而 model 中大量写成了 `gorm:"index,type:varchar(36)"`，按 ";" 切分后整段
	// 成为一个键，TagSettings["INDEX"] 恒为空，索引被静默丢弃且不报错。
	// 判据：`gorm:"index"` 与 `gorm:"index;其他"` 生效，`gorm:"index,其他"` 不生效。
	// 新增索引请一律加在此处，并核对与 model tag 的写法无关。
	//
	// CREATE INDEX IF NOT EXISTS 幂等，重复启动安全；大表首次建索引会锁表（一次性耗时）
	if err := migrateIndexes(db); err != nil {
		panic(fmt.Errorf("索引迁移失败: %v", err.Error()))
	}
	return db
}

// migrateIndexes 为高频查询/清理列补齐索引
func migrateIndexes(db *gorm.DB) error {
	indexes := []string{
		"CREATE INDEX IF NOT EXISTS idx_sessions_connected_time ON sessions(connected_time)",
		"CREATE INDEX IF NOT EXISTS idx_sessions_protocol ON sessions(protocol)",
		"CREATE INDEX IF NOT EXISTS idx_sessions_connection_id ON sessions(connection_id)",
		"CREATE INDEX IF NOT EXISTS idx_sessions_reviewed ON sessions(reviewed)",
		"CREATE INDEX IF NOT EXISTS idx_login_logs_login_time ON login_logs(login_time)",
		"CREATE INDEX IF NOT EXISTS idx_login_logs_state ON login_logs(state)",
		"CREATE INDEX IF NOT EXISTS idx_login_logs_logout_time ON login_logs(logout_time)",
		"CREATE INDEX IF NOT EXISTS idx_job_logs_job_id ON job_logs(job_id)",
		"CREATE INDEX IF NOT EXISTS idx_job_logs_timestamp ON job_logs(timestamp)",
		"CREATE INDEX IF NOT EXISTS idx_assets_protocol ON assets(protocol)",
		"CREATE INDEX IF NOT EXISTS idx_assets_active ON assets(active)",
		"CREATE INDEX IF NOT EXISTS idx_users_online ON users(online)",
		"CREATE INDEX IF NOT EXISTS idx_storage_logs_created ON storage_logs(created)",

		// --- 以下为 model tag 因逗号写法失效、此前缺失的高频查询列 ---
		// 登录按用户名查（每次登录都走，users 表此前仅有 online 一个索引）
		"CREATE INDEX IF NOT EXISTS idx_users_username ON users(username)",
		// 会话列表/清理按状态过滤（sessions 按年累积，此前仅能全表扫描）
		"CREATE INDEX IF NOT EXISTS idx_sessions_status ON sessions(status)",
		// 会话归属校验与会话文件操作
		"CREATE INDEX IF NOT EXISTS idx_sessions_asset_id ON sessions(asset_id)",
		"CREATE INDEX IF NOT EXISTS idx_sessions_creator ON sessions(creator)",
		// assets 此前有 protocol/active/sort_order，缺 owner——「我的资产」走全表扫描
		"CREATE INDEX IF NOT EXISTS idx_assets_owner ON assets(owner)",
		"CREATE INDEX IF NOT EXISTS idx_assets_credential_id ON assets(credential_id)",
		// authorised 此前整表零索引：资产授权校验（worker 的「我的资产」）走全表扫描
		"CREATE INDEX IF NOT EXISTS idx_authorised_user_id ON authorised(user_id)",
		"CREATE INDEX IF NOT EXISTS idx_authorised_user_group_id ON authorised(user_group_id)",
		"CREATE INDEX IF NOT EXISTS idx_authorised_asset_id ON authorised(asset_id)",
		// 存储日志按用户/资产/会话检索
		"CREATE INDEX IF NOT EXISTS idx_storage_logs_user_id ON storage_logs(user_id)",
		"CREATE INDEX IF NOT EXISTS idx_storage_logs_asset_id ON storage_logs(asset_id)",
		"CREATE INDEX IF NOT EXISTS idx_storage_logs_session_id ON storage_logs(session_id)",
		// 凭据/指令归属（管理员列表按 owner 过滤）
		"CREATE INDEX IF NOT EXISTS idx_credentials_owner ON credentials(owner)",
		"CREATE INDEX IF NOT EXISTS idx_commands_owner ON commands(owner)",
		// 注意表名是单数 access_token（见 model/access_token.go 的 TableName）
		"CREATE INDEX IF NOT EXISTS idx_access_token_token ON access_token(token)",
		"CREATE INDEX IF NOT EXISTS idx_access_token_user_id ON access_token(user_id)",
		// share_sessions 无 session_id 列，按 asset_id 建（该表 tag 同样是逗号写法故缺失）
		"CREATE INDEX IF NOT EXISTS idx_share_sessions_asset_id ON share_sessions(asset_id)",
	}
	start := time.Now()
	for _, idx := range indexes {
		if err := db.Exec(idx).Error; err != nil {
			return err
		}
	}
	fmt.Printf("索引迁移完成，耗时：%v\n", time.Since(start))
	return nil
}
