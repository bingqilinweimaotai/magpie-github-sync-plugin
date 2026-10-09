# Magpie GitHub 同步插件

将 [Magpie](https://usemagpie.ai) 的加密配置备份到 GitHub 仓库，方便在多台电脑之间同步和恢复，无需修改 Magpie。

这是一个非官方插件，通过 Magpie 的 Bun 插件宿主加载，提供仅监听 `127.0.0.1` 的本地 WebDAV 桥接服务。加密、合并、恢复、撤销和用量共享仍由 Magpie 的同步引擎处理，插件负责将文件操作转换为 GitHub Contents 和 Git Data API 请求。

## 安装

在 Magpie 的 **设置 → 插件 → 发现 → 非官方插件 · GitHub** 中搜索并安装 `magpie-github-sync-plugin`。仓库已添加 `magpie-plugin` 主题标签；能否在发现页中看到它，取决于 GitHub 搜索索引和 Magpie 缓存。较新版本约每十分钟刷新一次，旧版本可能缓存六小时。

也可以直接从 GitHub 仓库安装：

```sh
magpie plugin add github:bingqilinweimaotai/magpie-github-sync-plugin
```

安装后打开 **设置 → 插件**，让 Magpie 加载插件，并保持 Magpie 应用、`magpie web` 或网关运行。插件使用 Magpie 自带的 Bun 宿主，无需单独安装 Node.js、构建项目或运行安装脚本，也无需发布到 npm。

## 配置仓库

1. 保持 Magpie 运行，在浏览器中打开 [http://127.0.0.1:3437/](http://127.0.0.1:3437/)。
2. 填写已有的 GitHub 仓库（`owner/repo`），按需填写分支和文件夹，并提供对该仓库拥有 **Contents: read and write** 权限的 GitHub Token。建议使用私有仓库存放备份，然后保存配置。
3. 页面会生成本地桥接服务的地址（**Address**）、用户名（**User name**）和本地密码（**Local password**）。将它们填入 Magpie 的 **设置 → 同步 → WebDAV**。
4. 设置加密口令，选好需要同步的内容并保存。加密口令应与 GitHub Token 和本地密码不同。

配置页右上角可切换 **中文 / English**。首次打开时跟随浏览器语言，之后会在当前浏览器中记住选择；切换语言不会清空正在填写的内容。

保存前，插件会检查仓库和分支是否可访问；该检查无法保证分支保护规则允许写入。后续同步中的 GitHub 错误会显示在配置页面上。

备份保存在 `<folder>/magpie/magpie.magpie-backup`。可选的加密用量和配额文件保存在 `<folder>/magpie/usage/`。连续上传的日用量文件通过 Git Data API 合并为一次提交：例如首次补传 90 天用量，日用量部分只生成 1 次提交。设置备份、配额更新和过期文件清理仍单独提交，内容未变化时不会生成提交。

日用量上传先将加密内容保存为远端 Git blob，并将待提交的文件名和版本写入本地 `github-sync-plugin/usage-pending.json`，同时在 `usage-blobs/` 保存加密内容副本，再确认上传。Magpie 上传完日用量后读取用量目录时，桥接服务会先完成批量提交；提交失败会作为用量同步错误返回，暂存记录保留以便重试。连续空闲 15 秒或正常关闭桥接服务时也会提交；重新启动后会从本地加密副本恢复未完成的批次，完成后清理相应副本。同批次反复上传同一文件只保留最后一次内容。批量提交使用最新仓库目录树和普通快进更新，保留其他电脑的修改及现有提交历史。

如果仓库为空，首次备份会初始化默认分支；选择其他分支时，该分支必须已经存在。

## 在另一台电脑上恢复

在另一台电脑上安装插件，绑定 **相同的仓库、分支和文件夹**，再使用这台电脑生成的桥接凭据配置 WebDAV。在 Magpie 中使用 **相同的加密口令和同步内容选项**，点击 **恢复（Restore）** 即可。Magpie 会保留被替换的本地配置，供 **撤销（Undo）** 使用。自动同步和手动同步均通过 Magpie 原有的操作入口完成。

不同电脑的本地密码可以不同，插件不会接收加密口令。哪些供应商、密钥、设置、配置档案、Agent 模型和资料库数据可以迁移，由 Magpie 的备份规则决定；同步范围不包括克隆工作目录或复制电脑上的所有本地文件。

## 兼容性与运行方式

- 插件通过 WebDAV 桥接，同步页面中仍显示为 WebDAV，不会新增原生同步后端选项。由于插件页面没有独立的后台服务分类，它可能将此插件标为供应商；插件本身不会添加模型或虚拟供应商账号。
- 插件初始化时会启动桥接服务。原生同步 API 不会自行初始化插件；如果仅通过 CLI 同步时提示连接被拒绝，请先打开插件页面。
- 同一配置档案下的多个 Magpie 或 CLI 宿主会共享桥接服务。持有服务的宿主退出后，其他宿主会在约两秒内接管；在此期间发起的同步可能需要重试。
- 禁用或移除插件后，监听服务会在约两秒内关闭，已开始的操作会执行完毕。原有同步设置会保留；如果不再使用同步，还需关闭 WebDAV 同步。
- 不同配置档案需要使用不同端口。可运行 `magpie plugin options magpie-github-sync-plugin '{"port":3438}'`，然后访问 `http://127.0.0.1:3438/`。在 PowerShell 中，将 JSON 作为一个用单引号包裹的参数传入。
- 修改仓库、分支或文件夹后，生成的 WebDAV 地址也会变化，需要更新 Magpie 同步页面中的地址。旧地址会报错，以免意外访问其他仓库。
- WebDAV 与 S3 之间的切换沿用 Magpie 原有实现；插件不会添加原生 GitHub 同步的三后端配置选择器。

## 凭据与错误处理

配置和独立的本地桥接密码保存在 `<magpie-config>/github-sync-plugin/state.json`。在 POSIX 系统上，该文件权限为 `0600`；在 Windows 上，继承用户配置目录的访问控制权限（ACL）。该文件不包含在远程加密备份中，每台电脑都需要单独配置凭据。

GitHub Token 只会发送到 `https://api.github.com`，插件拒绝重定向。仅在仓库未改变时，将 Token 留空才会复用已保存的 Token；已保存的 Token 不会回填到配置表单。本地配置请求需要同源 CSRF Token，WebDAV 访问需要本地桥接密码。

写入时通过 blob SHA 检查文件版本。如果另一台电脑已修改备份，插件会返回前置条件失败，让 Magpie 重新读取并合并。仓库或分支不存在、元数据格式错误、读取失败和认证失败都会明确报错，不会被当作备份不存在处理。GitHub 限流信息会传回 Magpie，由其同步退避机制处理。

桥接服务仅接受已加密封装的 Magpie v1 文件：设置备份使用 `magpie-backup` 封装，用量和配额历史使用 `magpie-data` 封装，单个文件最大为 64 MiB。用量目录列表达到 GitHub 的 1,000 条上限时会明确报错。仓库提交历史会保留之前的加密版本。

## 开发与测试

插件没有运行时依赖，可使用以下命令运行测试：

```sh
npm test
```

测试使用临时配置档案、真实的本地 HTTP 请求和模拟的 GitHub API，不会读写用户的 Magpie 配置。CI 会在 Windows、Linux 和 macOS 上运行测试套件。

可选集成测试通过 `BUN_BIN` 和 `MAGPIE_HOST` 指定 Bun 与 Magpie 的 `internal/plugin/host.js`，通过 `MAGPIE_BIN` 指定 Magpie 可执行文件。测试会验证宿主接管和插件禁用，以及使用内存中的模拟 GitHub 服务进行原生加密上传、内容未变化时的同步、新配置档案中的恢复与撤销。开启用量同步时，还会验证 90 天用量合并为一次提交、配额的加密上传、跨配置档案下载合并及内容未变化时不新增提交。用量错误会单独检查同步状态，因为这类错误不会让 CLI 命令失败。测试配置档案均与用户文件隔离。

Magpie 集成参考：

- [插件指南](https://usemagpie.ai/docs/plugins)
- [插件宿主](https://github.com/yetone/magpie/blob/main/internal/plugin/host.js)
- [GitHub 插件发现](https://github.com/yetone/magpie/blob/main/internal/plugin/github.go)
- [原生 WebDAV 同步](https://github.com/yetone/magpie/blob/main/internal/davsync/dav.go)

## License

[MIT](LICENSE)
