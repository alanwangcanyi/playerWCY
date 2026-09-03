# Skill：版本号三处同步（playerWCY）

## 问题场景和根本原因

**场景**：CHANGELOG 已记录多个版本迭代，但软件 About 页显示的版本号停在旧值。

**根本原因**：升版本时只更新了 `docs/CHANGELOG.md` 的版本记录，漏改代码中的版本号。About 页读取的是 `src-tauri/tauri.conf.json` 的 `version` 字段（打包时写入 Info.plist 的 CFBundleShortVersionString）。

## 需要检查的代码位置

每次 CHANGELOG 出现新版本号（如 `v1.4.1 / 0024`）时，以下三处必须同步为相同版本：

1. `package.json` → `"version": "x.y.z"`
2. `src-tauri/tauri.conf.json` → `"version": "x.y.z"`
3. `src-tauri/Cargo.toml` → `version = "x.y.z"`

## 修复代码模板

```bash
# 一键同步（示例：1.4.1）
python3 -c "
import json
for p in ['package.json', 'src-tauri/tauri.conf.json']:
    with open(p) as f: d = json.load(f)
    d['version'] = '1.4.1'
    with open(p, 'w') as f: json.dump(d, f, ensure_ascii=False, indent=2); f.write('\n')
"
# Cargo.toml 手动/替换 version = \"1.4.1\"
```

## 搜索关键词

- `"version":`（json 两处）
- `version = "`（Cargo.toml）
- CHANGELOG 头部最新条目的版本号即为目标值

## 验证方法

1. 编译后点软件 About，对比 CHANGELOG 最新版本
2. 命令行验证：
   ```bash
   plutil -p "20260901-playerWCY-archive/最新.app/Contents/Info.plist" | grep -i version
   ```
3. 三处文件 grep 版本号一致后才可提交

## 关联规则

README.md「修改前必读」第 3 条（版本号同步强制规则）。
