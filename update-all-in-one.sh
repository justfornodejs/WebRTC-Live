#!/bin/bash
# 一键更新脚本 - 复制此脚本内容到服务器 SSH 会话中执行

# 拉取最新代码
cd /opt/WebRTC-Live
git pull

# 创建必要目录
mkdir -p backend/recordings
mkdir -p dvr

# 重启 SRS 服务
docker-compose restart

# 重启 Flask 后端
pm2 restart webrtc-live

# 等待服务启动
sleep 5

# 检查服务状态
echo "===== 服务状态 ====="
docker-compose ps
pm2 status webrtc-live
