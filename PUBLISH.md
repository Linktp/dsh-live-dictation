# 发布记录与再发布手册

## 0.1.0（2026-11-22 已发布）

- npm：https://www.npmjs.com/package/dsh-live-dictation —— `0.1.0`，10 个文件 / 14.3 kB（解包 40.7 kB），shasum `ff9eb52070ce30649c5bb4bc43c840618a6f306e`
- GitHub：https://github.com/Linktp/dsh-live-dictation —— tag `v0.1.0` 已推送；提交身份 `Linktp <46404681+Linktp@users.noreply.github.com>`
- 早期元数据已补齐：`author` / `repository` / `homepage` / `bugs`
- 遗留：包内多出一个占位版本 `0.0.0-stage`（npm staged publishing 为尚未存在的包自动创建）。确认 `0.1.0` 正常后可以清掉：

```powershell
npm unpublish dsh-live-dictation@0.0.0-stage
```

## 必须记住的四个坑

1. **npm 已下线 TOTP**。新账号只能注册安全密钥（WebAuthn：手机通行密钥 / Windows Hello / 硬件钥匙），发布必须通过 2FA。
2. **granular token 必须勾 `Bypass two-factor authentication`** 才能免交互发布。否则 `npm publish` 一律 `403 Two-factor authentication or granular access token with bypass 2fa enabled is required`，加 `--otp=` 也没用（安全密钥不产生 6 位码）。
3. **无头终端里发不出去**。2FA 要走浏览器出示安全密钥，`npm publish` 必须在**交互式 PowerShell 窗口里裸跑**（输出别接管道）。
4. **发布后 tarball 有延迟**。`dist-tags` 立刻变成新版本，但 `https://registry.npmjs.org/dsh-live-dictation/-/dsh-live-dictation-X.Y.Z.tgz` 可能先 404，等 1–2 分钟再验证安装。

## 再发布流程

1. 改 `package.json` 的 `version`（bug 修复 `0.1.x`，新能力 `0.2.0`）
2. 检查清单：`npm pack --dry-run`（文件名 + 体积）
3. 交互终端发布：

```powershell
cd C:\Users\10038\Documents\deepseek-harness\default-workspace\plugins\dsh-live-dictation
npm publish
```

4. 打 tag 并推送：

```powershell
git add -A
git commit -m "release: vX.Y.Z"
git tag -a vX.Y.Z -m "dsh-live-dictation vX.Y.Z"
git push origin main --tags
```

5. 验证（等 1–2 分钟再跑）：

```powershell
npm view dsh-live-dictation version
$t = "$env:TEMP\dshtest-$(Get-Random)"; mkdir $t | Out-Null
npm install --prefix $t --prefer-online dsh-live-dictation@X.Y.Z
```

6. 用户在 DSH 里升级：插件管理器更新到新版本，然后**重启应用**（客户端模块有缓存；只禁用/启用 bundle 也能让客户端代码重新加载）。

## 让市场收录

1. **npm 检索**：发布即生效（关键词 `dsh-plugin`、`deepseek-harness`、`push-to-talk` 等）。
2. **GitHub topic**：仓库 → ⚙ About → Topics 加 `dsh-plugin`（`dsh.works`、plugin-radar 等目录按仓库 + topic 索引）。
3. 收录有抓取周期；`dsh.works` 会核对安装路径与 dsh 版本，可能需要等一两天。
