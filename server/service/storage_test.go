package service

import (
	"path"
	"path/filepath"
	"strings"
	"testing"
)

// TestResolveStoragePath 覆盖存储路径解析的安全边界。
//
// 回归背景：原实现用 strings.Contains(rel, "../") 做黑名单校验，file=".." 不含
// 该子串从而绕过，path.Join 将其归一化为存储根，最终 StorageRm 的 os.RemoveAll
// 递归清空整个 drive 目录（影响所有用户）。这里的用例把该绕过及其变体固定下来。
func TestResolveStoragePath(t *testing.T) {
	const drive = "/data/drive"
	const storageId = "user-1"
	base := path.Join(drive, storageId)

	// 必须被拒绝：解析结果落在存储根之外
	escapes := []string{
		"..",        // 原漏洞：不含 "../" 子串
		"../",       // 旧校验拦得住，仍须拦住
		"../..",     // 逃到 drive 根之上
		"../../etc", // 逃出 drive
		"a/../..",   // 中途合法、最终逃逸
		"./../",     // 前缀干扰
		"x/../../y", // 逃逸后再进入
		"/../",      // 绝对路径前缀
	}
	for _, rel := range escapes {
		got, err := resolveStoragePath(drive, storageId, rel)
		if err == nil {
			t.Errorf("resolveStoragePath(%q) = %q, 期望被拒绝", rel, got)
		}
		if _, err := resolveStoragePathStrict(drive, storageId, rel); err == nil {
			t.Errorf("resolveStoragePathStrict(%q) 期望被拒绝", rel)
		}
	}

	// 归一化后恰好等于存储根本身：不是逃逸，但破坏性操作必须拒绝。
	//
	// "....//.." 是原黑名单的第二个绕过串（"...." 是普通目录名，"//" 被 Clean
	// 折叠，末尾 ".." 弹出 "...."），旧代码下 StorageRm 会以存储根为对象执行
	// RemoveAll，清空该用户的整个空间。
	//
	// 注意 ".." 不在此列——它解析到 base 的父目录（即 drive 根），属逃逸，
	// 对应原漏洞的最严重形态：清空所有用户的文件。
	atRoot := []string{"", ".", "./", "....//.."}
	for _, rel := range atRoot {
		got, err := resolveStoragePath(drive, storageId, rel)
		if err != nil {
			t.Errorf("resolveStoragePath(%q) 宽松模式不应报错, got err=%v", rel, err)
			continue
		}
		if got != base {
			t.Errorf("resolveStoragePath(%q) = %q, 期望归一化到 %q", rel, got, base)
		}
		if _, err := resolveStoragePathStrict(drive, storageId, rel); err == nil {
			t.Errorf("resolveStoragePathStrict(%q) 应拒绝解析到存储根（破坏性操作）", rel)
		}
	}

	// 正常子路径：两种模式都应放行，且结果落在 base 之下。
	// "..%2f" 里的 %2f 到达此处时已由 HTTP 层解码完毕，残留的属普通文件名字符。
	normal := map[string]string{
		"a.txt":      path.Join(base, "a.txt"),
		"ops/di":     path.Join(base, "ops/di"),
		"a/b/c.txt":  path.Join(base, "a/b/c.txt"),
		"a/../b.txt": path.Join(base, "b.txt"), // 归一化后仍在根内，允许
		"..%2f":      path.Join(base, "..%2f"),
	}
	for rel, want := range normal {
		got, err := resolveStoragePathStrict(drive, storageId, rel)
		if err != nil {
			t.Errorf("resolveStoragePathStrict(%q) 不应报错, got err=%v", rel, err)
			continue
		}
		if got != want {
			t.Errorf("resolveStoragePathStrict(%q) = %q, 期望 %q", rel, got, want)
		}
		if !strings.HasPrefix(got, base+"/") {
			t.Errorf("resolveStoragePathStrict(%q) = %q 逃出了存储根 %q", rel, got, base)
		}
	}

	// 前缀断言不能靠裸 HasPrefix：同级的兄弟目录 /data/drive-other 不得被误放行
	sibling := "/data/drive-other"
	if _, err := resolveStoragePath(drive, storageId, path.Join("..", "..", "drive-other")); err == nil {
		t.Errorf("逃逸到同级目录 %q 应被拒绝", sibling)
	}
}

// TestSafeRecordingPath 覆盖录屏删除的路径安全边界。
//
// 回归背景：sessionIds 直接来自 URL（DELETE /sessions/:id 支持逗号分隔多个 ID），
// 未做存在性校验。id 为 ".." 时 path.Join(recordingPath, "..") 会归一化为录屏目录的
// 父目录 —— 默认配置下即 data/，其中含 SQLite 数据库与 drive 存储，
// 一次 os.RemoveAll 就会连库一起删掉。
func TestSafeRecordingPath(t *testing.T) {
	const recording = "/usr/local/next-terminal/data/recording"
	base := filepath.Clean(recording)

	// 必须被拒绝
	rejected := []string{
		"..",    // 逃到 data/（含 SQLite 库）
		"../..", // 逃到 next-terminal/
		"",
		"a/b", // 含路径分隔符
		`a\b`, // Windows 风格分隔符
		".",
		"./..",
	}
	for _, id := range rejected {
		if got, ok := safeRecordingPath(recording, id); ok {
			t.Errorf("safeRecordingPath(%q) = %q, 期望被拒绝", id, got)
		}
	}

	// 正常会话 ID 必须放行，且落在录屏根之下
	for _, id := range []string{
		"0a8146de35f04453978406ae2a174b03",
		"session-1",
		"a..b", // 含连续点号但是合法文件名，不应被误伤
	} {
		got, ok := safeRecordingPath(recording, id)
		if !ok {
			t.Errorf("safeRecordingPath(%q) 不应被拒绝", id)
			continue
		}
		if !strings.HasPrefix(got, base+string(filepath.Separator)) {
			t.Errorf("safeRecordingPath(%q) = %q 逃出了录屏根 %q", id, got, base)
		}
	}
}
