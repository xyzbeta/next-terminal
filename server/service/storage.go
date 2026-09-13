package service

import (
	"bufio"
	"context"
	"errors"
	"fmt"
	"io"
	"io/ioutil"
	"mime/multipart"
	"net/http"
	"os"
	"path"
	"strconv"
	"strings"

	"next-terminal/server/common"
	"next-terminal/server/config"
	"next-terminal/server/model"
	"next-terminal/server/repository"
	"next-terminal/server/utils"

	"github.com/labstack/echo/v4"
	"gorm.io/gorm"
)

var StorageService = new(storageService)

type storageService struct {
}

func (service storageService) InitStorages() error {
	users, err := repository.UserRepository.FindAll(context.TODO())
	if err != nil {
		return err
	}
	for i := range users {
		userId := users[i].ID
		_, err := repository.StorageRepository.FindByOwnerIdAndDefault(context.TODO(), userId, true)
		if errors.Is(err, gorm.ErrRecordNotFound) {
			err = service.CreateStorageByUser(context.TODO(), &users[i])
			if err != nil {
				return err
			}
		}
	}

	drivePath := service.GetBaseDrivePath()
	storages, err := repository.StorageRepository.FindAll(context.TODO())
	if err != nil {
		return err
	}
	for i := 0; i < len(storages); i++ {
		storage := storages[i]
		// 判断是否为遗留的数据：磁盘空间在，但用户已删除
		if storage.IsDefault {
			var userExist = false
			for j := range users {
				if storage.ID == users[j].ID {
					userExist = true
					break
				}
			}

			if !userExist {
				if err := service.DeleteStorageById(context.TODO(), storage.ID, true); err != nil {
					return err
				}
			}
		}

		storageDir := path.Join(drivePath, storage.ID)
		if !utils.FileExists(storageDir) {
			if err := os.MkdirAll(storageDir, os.ModePerm); err != nil {
				return err
			}
		}
	}
	return nil
}

func (service storageService) CreateStorageByUser(c context.Context, user *model.User) error {
	drivePath := service.GetBaseDrivePath()
	var limitSize int64
	property, err := repository.PropertyRepository.FindByName(c, "user-default-storage-size")
	if err != nil {
		return err
	}
	limitSize, err = strconv.ParseInt(property.Value, 10, 64)
	if err != nil {
		return err
	}

	limitSize = limitSize * 1024 * 1024
	if limitSize < 0 {
		limitSize = -1
	}

	storage := model.Storage{
		ID:        user.ID,
		Name:      user.Nickname + "的默认空间",
		IsShare:   false,
		IsDefault: true,
		LimitSize: limitSize,
		Owner:     user.ID,
		Created:   common.NowJsonTime(),
	}
	storageDir := path.Join(drivePath, storage.ID)
	if err := os.MkdirAll(storageDir, os.ModePerm); err != nil {
		return err
	}
	err = repository.StorageRepository.Create(c, &storage)
	if err != nil {
		_ = os.RemoveAll(storageDir)
		return err
	}
	return nil
}

type File struct {
	Name    string          `json:"name"`
	Path    string          `json:"path"`
	IsDir   bool            `json:"isDir"`
	Mode    string          `json:"mode"`
	IsLink  bool            `json:"isLink"`
	ModTime common.JsonTime `json:"modTime"`
	Size    int64           `json:"size"`
}

func (service storageService) Ls(drivePath, remoteDir string) ([]File, error) {
	fileInfos, err := ioutil.ReadDir(path.Join(drivePath, remoteDir))
	if err != nil {
		return nil, err
	}

	var files = make([]File, 0)
	for i := range fileInfos {
		file := File{
			Name:    fileInfos[i].Name(),
			Path:    path.Join(remoteDir, fileInfos[i].Name()),
			IsDir:   fileInfos[i].IsDir(),
			Mode:    fileInfos[i].Mode().String(),
			IsLink:  fileInfos[i].Mode()&os.ModeSymlink == os.ModeSymlink,
			ModTime: common.NewJsonTime(fileInfos[i].ModTime()),
			Size:    fileInfos[i].Size(),
		}

		files = append(files, file)
	}
	return files, nil
}

func (service storageService) GetBaseDrivePath() string {
	return config.GlobalCfg.Guacd.Drive
}

// resolveStoragePath 把用户可控的相对路径安全地解析到指定存储空间根目录之内。
//
// 安全边界：rel 允许含多级子目录（如 "ops/di"），但不得逃出 base。
//
// 这里用「Clean 归一化后再做前缀断言」，而不是原先的字符串黑名单——
// 后者拦不住 ".."（不含子串 "../"）、"a/../.." 等写法：path.Join 会把它们
// 归一化到父目录，最终 RemoveAll/Rename 会作用在存储根甚至 drive 根上。
// 同理也不能靠「结果是否以 base 开头」判断，否则 /data/drive-other 会被误放行。
//
// 返回路径保证等于 base，或位于 base 之下。
func resolveStoragePath(drivePath, storageId, rel string) (string, error) {
	base := path.Join(drivePath, storageId)
	if rel == "" {
		rel = "."
	}
	target := path.Clean(path.Join(base, rel))
	if target == base {
		return target, nil
	}
	if !strings.HasPrefix(target, base+"/") {
		return "", errors.New("非法请求 :(")
	}
	return target, nil
}

// resolveStoragePathStrict 在 resolveStoragePath 之上额外拒绝解析结果等于存储根本身。
// 用于删除、重命名、下载、写入等「作用于单个条目」的操作——它们没有理由作用在存储根上，
// 而一旦允许，RemoveAll/Rename/ServeFile 就会以整个存储空间为对象。
func resolveStoragePathStrict(drivePath, storageId, rel string) (string, error) {
	target, err := resolveStoragePath(drivePath, storageId, rel)
	if err != nil {
		return "", err
	}
	if target == path.Join(drivePath, storageId) {
		return "", errors.New("非法请求 :(")
	}
	return target, nil
}

func (service storageService) DeleteStorageById(c context.Context, id string, force bool) error {
	drivePath := service.GetBaseDrivePath()
	storage, err := repository.StorageRepository.FindById(c, id)
	if err != nil {
		if errors.Is(err, gorm.ErrRecordNotFound) {
			return nil
		}
		return err
	}
	if !force && storage.IsDefault {
		return errors.New("默认空间不能删除")
	}

	// 删除对应的本地目录
	if err := os.RemoveAll(path.Join(drivePath, id)); err != nil {
		return err
	}
	if err := repository.StorageRepository.DeleteById(c, id); err != nil {
		return err
	}
	return nil
}

func (service storageService) StorageUpload(c echo.Context, file *multipart.FileHeader, storageId string) error {
	drivePath := service.GetBaseDrivePath()
	storage, err := repository.StorageRepository.FindById(context.TODO(), storageId)
	if err != nil {
		return err
	}
	if storage.LimitSize > 0 {
		dirSize, err := utils.DirSize(path.Join(drivePath, storageId))
		if err != nil {
			return err
		}
		if dirSize+file.Size > storage.LimitSize {
			return errors.New("可用空间不足")
		}
	}

	filename := file.Filename
	src, err := file.Open()
	if err != nil {
		return err
	}
	defer src.Close()

	remoteDir := c.QueryParam("dir")

	// 目标目录：允许解析到存储根本身（上传到根目录是正常操作）
	dir, err := resolveStoragePath(drivePath, storageId, remoteDir)
	if err != nil {
		return err
	}
	// 判断文件夹不存在时自动创建
	if !utils.FileExists(dir) {
		if err := os.MkdirAll(dir, os.ModePerm); err != nil {
			return err
		}
	}
	// Destination：filename 虽已由 multipart 层做 Base() 清洗，此处仍按完整相对路径
	// 再解析一次，避免清洗行为变化时直接落到存储根之外
	dstPath, err := resolveStoragePathStrict(drivePath, storageId, path.Join(remoteDir, filename))
	if err != nil {
		return err
	}
	dst, err := os.Create(dstPath)
	if err != nil {
		return err
	}
	defer dst.Close()

	// Copy
	if _, err = io.Copy(dst, src); err != nil {
		return err
	}
	return nil
}

func (service storageService) StorageEdit(file string, fileContent string, storageId string) error {
	drivePath := service.GetBaseDrivePath()
	realFilePath, err := resolveStoragePathStrict(drivePath, storageId, file)
	if err != nil {
		return err
	}
	dstFile, err := os.OpenFile(realFilePath, os.O_WRONLY|os.O_CREATE|os.O_TRUNC, 0666)
	if err != nil {
		return err
	}
	defer dstFile.Close()
	write := bufio.NewWriter(dstFile)
	if _, err := write.WriteString(fileContent); err != nil {
		return err
	}
	if err := write.Flush(); err != nil {
		return err
	}
	return nil
}

func (service storageService) StorageDownload(c echo.Context, file, storageId string) error {
	drivePath := service.GetBaseDrivePath()
	p, err := resolveStoragePathStrict(drivePath, storageId, file)
	if err != nil {
		return err
	}
	// 获取带后缀的文件名称（取自已解析路径，避免 file 为空时 basename 为 "."）
	filenameWithSuffix := path.Base(p)
	//log.Infof("download %v", p)
	c.Response().Header().Set("Content-Disposition", fmt.Sprintf("attachment; filename=%s", filenameWithSuffix))
	c.Response().Header().Set("Content-Type", "application/octet-stream")

	http.ServeFile(c.Response(), c.Request(), p)
	return nil
}

func (service storageService) StorageLs(remoteDir, storageId string) (error, []File) {
	drivePath := service.GetBaseDrivePath()
	// 列目录允许解析到存储根本身。这里只做断言，随后仍以 base + remoteDir 调用 Ls，
	// 以保留 File.Path 的相对语义（前端依赖它做目录跳转）；
	// Ls 内部拼接的正是同一个表达式，断言通过即等价于已校验。
	if _, err := resolveStoragePath(drivePath, storageId, remoteDir); err != nil {
		return err, nil
	}
	files, err := service.Ls(path.Join(drivePath, storageId), remoteDir)
	if err != nil {
		return err, nil
	}
	return nil, files
}

func (service storageService) StorageMkDir(remoteDir, storageId string) error {
	drivePath := service.GetBaseDrivePath()
	dir, err := resolveStoragePath(drivePath, storageId, remoteDir)
	if err != nil {
		return err
	}
	if err := os.MkdirAll(dir, os.ModePerm); err != nil {
		return err
	}
	return nil
}

func (service storageService) StorageRm(file, storageId string) error {
	drivePath := service.GetBaseDrivePath()
	// 严格模式：删除必须作用于存储根之下的具体条目。
	// 允许 file=".." 解析为存储根会让 RemoveAll 递归清空整个 drive 目录。
	target, err := resolveStoragePathStrict(drivePath, storageId, file)
	if err != nil {
		return err
	}
	if err := os.RemoveAll(target); err != nil {
		return err
	}
	return nil
}

func (service storageService) StorageRename(oldName, newName, storageId string) error {
	drivePath := service.GetBaseDrivePath()
	oldPath, err := resolveStoragePathStrict(drivePath, storageId, oldName)
	if err != nil {
		return err
	}
	newPath, err := resolveStoragePathStrict(drivePath, storageId, newName)
	if err != nil {
		return err
	}
	// Rename 会连带搬移整棵子树，故源与目标都必须是存储根之下的条目
	if err := os.Rename(oldPath, newPath); err != nil {
		return err
	}
	return nil
}
