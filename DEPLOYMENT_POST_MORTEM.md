# 🚀 WebRTC-Live 部署同步故障复盘与标准化操作建议

## 1. 案例回顾 (事故复盘)
在本次功能增强任务中，尝试同步 `admin.html` 及相关功能至 10.0.6.62 物理机时，连续出现了 404 错误与同步失效。

### 核心原因分析：
1.  **Shell 环境语法不兼容**：
    - **现象**: 本地执行 `git add && commit && push` 报错。
    - **诱因**: 本地 Agent 运行在 **Windows PowerShell** 环境下，而习惯性使用了 Linux 的 `&&` 语句连接符（PowerShell 需使用 `;`）。导致代码从未真正推送到远程仓库。
2.  **Git 链路与物理落地的非对称性**：
    - **现象**: 远程 `deploy.sh` 执行成功，但文件未见更新。
    - **诱因**: `deploy.sh` 从服务器本地 Gitea 仓库拉取代码。由于本地 Push 失败，远程 Pull 到的依然是旧代码。物理机上的 `ls` 命令直接打脸了“逻辑同步”的假象。
3.  **Docker 镜像与 Volume 的隔离性**：
    - **现象**: 即便物理文件存在，浏览器访问依然 404。
    - **诱因**: 原 `docker-compose.yml` 仅挂载了 `recordings` 目录。`frontend` 目录是打包在镜像内部的。这意味着单纯同步物理文件无效，必须执行耗时的 `docker build`。
4.  **Flask 静态处理的盲区**：
    - **现象**: 通配符路由未生效。
    - **诱因**: Flask 在处理 `static_url_path=""` 时，对于新创建的文件，如果没在主进程启动时建立映射缓存或显式定义路由，有时会出现 MIME 类型匹配异常或索引失败。

---

## 2. 🛡️ 避坑指南 (标准化建议)

### A. 强化物理挂载 (Hot-Swap)
**原则**: 生产环境的前端静态目录 **必须显式挂载**，而不仅仅是 `COPY`。
- **配置**: 在 `docker-compose.yml` 中增加 `./frontend:/app/frontend`。
- **收益**: 无需重新构建镜像即可通过 `scp` 或 `git pull` 实现页面秒级更新。

### B. 终端语法防御
**原则**: 在执行多条命令时，优先使用分号 `;` 或独立执行。
- **技巧**: 在 Windows 环境下工作时，明确指定 `powershell -Command "..."` 且避免使用 `&&`。

### C. 部署验证三部曲
**原则**: 绝不以“脚本执行成功”作为交付标准。
1.  **物理核查**: `ssh root@host "ls -la /path/to/file"` 确认文件已物理落地。
2.  **内部探测**: 在服务器本地 `curl -I http://localhost:PORT/file.html`，排除外部防火墙/CDN 干扰。
3.  **容器日志**: `docker logs --tail 20 container_name` 确认后端无启动报错。

### D. 强制热重启
**原则**: 修改后端代码 (`.py`) 或配置后，必须执行容器重启。
- **推荐指令**: `docker restart <container_name>` 或 `docker compose up -d --force-recreate`。

---

## 3. 📝 下次项目启动建议
若后续 Agent 接入，请务必先运行：
```bash
# 检查同步通道
ssh -T -p 2222 git@10.0.6.62
# 检查物理路径映射
docker inspect webrtc-app --format '{{ .Mounts }}'
```

---
**文档版本**: v1.0
**作者**: Antigravity AI
**状态**: 已归档
