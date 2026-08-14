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
			}
		}
	} else {
		// WAL：读写不再互斥；busy_timeout：并发写等待 5s 而非立即 SQLITE_BUSY；foreign_keys：外键约束
		dsn := fmt.Sprintf("file:%s?cache=shared&mode=rwc&_pragma=journal_mode(WAL)&_pragma=busy_timeout(5000)&_pragma=foreign_keys(1)", config.GlobalCfg.Sqlite.File)
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
