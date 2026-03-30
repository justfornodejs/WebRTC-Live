# WebRTC-Live 服务器部署指南

## 部署步骤

### 1. 首次部署

如果服务器上还没有代码，需要先克隆仓库：

```bash
# 克隆仓库
git clone https://github.com/justfornodejs/WebRTC-Live.git
cd WebRTC-Live

# 配置环境变量
cp backend/.env.example backend/.env
# 编辑 backend/.env，配置 SRS 服务器地址

# 生成 SSL 证书（如果还没有）
bash gen_ssl.sh

# 启动服务
docker-compose up -d
nohup python backend/app.py > logs/app.log 2>&1 &
```

### 2. 更新部署（使用自动脚本）

使用 `deploy.sh` 脚本自动部署：

```bash
# 1. 复制脚本到服务器（如果还没有）
# 在本地上传 deploy.sh 到服务器
scp deploy.sh user@server:/path/to/WebRTC-Live/

# 2. SSH 连接到服务器
ssh user@server

# 3. 进入项目目录
cd /path/to/WebRTC-Lugs-Live

# 4. 修改脚本中的项目路径（如果不是默认路径）
nano deploy.sh
# 将 PROJECT_DIR="/path/to/WebRTC-Live" 改为实际路径

# 5. 给脚本执行权限
chmod +x deploy.sh

# 6. 运行部署脚本
./deploy.sh
```

### 3. 手动更新部署（如果不使用脚本）

```bash
# 进入项目目录
cd /path/to/WebRTC-Live

# 拉取最新代码
git pull

# 创建必要目录
mkdir -p backend/recordings
mkdir -p dvr

# 重启 SRS 服务
docker-compose restart

# 重启 Flask 后端
# PM2 方式
pm2 restart webrtc-live

# 或 systemd 方式
sudo systemctl restart webrtc-live

# 或手动方式
pkill -f "python backend/app.py"
nohup python backend/app.py > logs/app.log 2>&1 &
```

## 部署验证

### 1. 检查服务状态

```bash
# 检查 SRS 状态
docker-compose ps

# 检查 Flask 后端状态
pm2 status webrtc-live
# 或
sudo systemctl status webrtc-live
# 或
ps aux | grep python
```

### 2. 测试 API 接口

```bash
# 健康检查
curl http://localhost:5000/api/health

# 获取录制列表
curl http://localhost:5000/api/recordings/list
```

### 3. 测试录制功能

1. 访问推流页面：`http://your-server:5000/publish.html`
2. 开始推流
3. 点击"开始录制"按钮
4. 停止录制并下载
5. 或选择"服务器存储"模式，上传后检查 `backend/recordings/` 目录

6. 访问拉流页面：`http://your-server:5000/play.html`
7. 开始拉流
8. 点击"开始录制"按钮
9. 测试录制和上传功能

### 4. 检查 SRS 服务端录制

```bash
# 查看 DVR 录制文件
ls -la dvr/

# 或通过 Docker 查看
docker exec srs-server ls -la /usr/local/srs/objs/nginx/html/dvr/
```

## 常见问题

### Q1: Git 拉取取失败

**问题**: `fatal: unable to access...`

**解决**:
- 检查网络连接
- 如果是私有仓库，需要配置 SSH 密钥或 token
- 确认仓库地址正确

### Q2: SRS 重启失败

**问题**: `docker-compose restart` 报错

**解决**:
```bash
# 检查 Docker 状态
sudo systemctl status docker

# 检查容器日志
docker-compose logs

# 手动重启
docker-compose down
docker-compose up -d
```

### Q3: Flask 后端无法启动

**问题**: 后端进程没有运行

**解决**:
```bash
# 查看错误日志
tail -f logs/app.log

# 或手动运行查看错误
python backend/app.py
```

### Q4: 录制上传失败

**问题**: 上传到服务器失败

**解决**:
- 检查 `backend/recordings` 目录权限
- 检查磁盘空间
- 查看 Flask 日志中的错误信息

### Q5: SRS DVR 没有生成文件

**问题**: 推流后 DVR 目录为空

**解决**:
- 检查 `srs.conf` 中 DVR 配置是否正确
- 确认 Docker 卷挂载正确
- 查看 SRS 日志：`docker-compose logs srs`

## 防火墙配置

确保以下端口已开放：

```bash
# HTTP (Flask)
sudo firewall-cmd --permanent --add-port=5000/tcp

# HTTPS (Flask SSL)
sudo firewall-cmd --permanent --add-port=443/tcp

# WebRTC UDP
sudo firewall-cmd --permanent --add-port=8000/udp

# RTMP (可选）
sudo firewall-cmd --permanent --add-port=1935/tcp

# SRS HTTP API (可选）
sudo firewall-cmd --permanent --add-port=1985/tcp

# 重载防火墙
sudo firewall-cmd --reload
```

## 性能优化建议

### 1. 限制录制文件大小

编辑 `srs.conf`，调整 `dvr_duration` 参数：

```conf
dvr {
    enabled     on;
    dvr_path    ./objs/nginx/html/dvr/[stream]/[2006]/[01]/[15]/[04]-[20]_[15]_[02]_[9999].flv;
    dvr_plan    session;
    dvr_duration    1800;  # 改为 30 分钟（秒）
    wait_keyframe   no;
}
```

### 2. 清理旧录制文件

创建定时任务清理旧文件：

```bash
# 创建清理脚本
cat > /path/to/WebRTC-Live/cleanup.sh << 'EOF'
#!/bin/bash
# 清理 7 天前的 DVR 文件
find /path/to/WebRTC-Live/dvr -type f -mtime +7 -delete
# 清理 30 天前的上传录制
find /path/to/WebRTC-Live/backend/recordings -type f -mtime +30 -delete
EOF

chmod +x /path/to/WebRTC-Live/cleanup.sh

# 添加到 crontab（每天凌晨 3 点执行）
crontab -e
# 添加以下行：
# 0 3 * * * /path/to/WebRTC-Live/cleanup.sh >> /var/log/cleanup.log 2>&1
```

## 监控和日志

### 查看实时日志

```bash
# SRS 日志
docker-compose logs -f srs

# Flask 后端日志
tail -f logs/app.log

# 或使用 PM2
pm2 logs webrtc-live
```

### 系统资源监控

```bash
# CPU 和内存使用
htop

# 磁盘使用
df -h

# 网络连接
netstat -an | grep 5000
```

## 备份和恢复

### 备份录制文件

```bash
# 备份 DVR 录制
tar -czf backup/dvr_$(date +%Y%m%d).tar.gz dvr/

# 备份上传的录制
tar -czf backup/recordings_$(date +%Y%m%d).tar.gz backend/recordings/
```

### 恢复录制文件

```bash
# 解压备份
tar -xzf backup/dvr_20240101.tar.gz
tar -xzf backup/recordings_20240101.tar.gz
```

## 联系支持

如果遇到问题，请提供以下信息：

1. 服务器操作系统和版本
2. Docker 版本：`docker --version`
3. Python 版本：`python --version`
4. 相关日志内容
5. 错误截图或详细描述
