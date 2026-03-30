#!/bin/bash
# WebRTC-Live 生产部署标准化脚本 (本地物理同步版)
set -e

PROJECT_DIR="/opt/projects/webrtc-live"
# 私有云内部物理同步路径
GIT_REMOTE="/opt/infrastructure/gitea_data/git/repositories/admin/webrtc-live.git"

echo ">>> [1/3] 正在通过本地总线同步源码..."
mkdir -p $PROJECT_DIR
cd $PROJECT_DIR

if [ ! -d ".git" ]; then
    echo "初始化新部署..."
    find . -maxdepth 1 ! -name '.' -exec rm -rf {} +
    git clone $GIT_REMOTE .
else
    echo "执行增量拉取..."
    # 强制重置以防止冲突
    git fetch origin master
    git reset --hard origin/master
fi

echo ">>> [2/3] 正在构建并拉起生产级 Docker 容器..."
docker compose up -d --build

echo ">>> [3/3] 服务状态检查..."
docker ps --filter "name=webrtc"

echo ">>> ✅ 部署完成！WebRTC-Live 服务已在端口 5000 (HTTP) 上线。"
echo ">>> SRS 流媒体服务器已在端口 1985 (API) / 1935 (RTMP) / 8000 (UDP) 上线。"
