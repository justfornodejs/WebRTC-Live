# ============================================================
# WebRTC-Live Docker 镜像构建文件 (生产规范版)
#
# 功能描述：构建基于 Python Flask 的 WebRTC 实时直播服务容器
#           遵循 Google 编程规范，支持非特权用户运行
#
# 架构说明：
#   - 基础镜像: python:3.11-slim (最小化攻击面)
#   - 进程管理: Gunicorn (生产级 WSGI 容器)
#   - 权限管控: 切换至 appuser 运行，确保容器逃逸防护
#
# 作者：Antigravity (资深架构师)
# 版本：1.1.0 (PaaS 规范版)
# ============================================================

# 阶段 1: 基础镜像与环境准备
FROM python:3.11-slim

# 设置工作目录
WORKDIR /app

# 设置环境变量，确保 Python 输出直接同步到日志
ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    FLASK_APP=backend/app.py \
    FLASK_PORT=5000

# 安装系统级依赖 (如果需要)
# RUN apt-get update && apt-get install -y --no-install-recommends gcc && rm -rf /var/lib/apt/lists/*

# 阶段 2: 依赖安装
# 优先复制 requirements.txt 以利用缓存
COPY backend/requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# 阶段 3: 应用部署与权限调整
# 复制后端代码
COPY backend/ ./backend/
# 复制前端资源
COPY frontend/ ./frontend/

# 创建录制文件夹并预设权限
# PVE PaaS 规范: 必须在切换 USER 前完成权限调整
RUN mkdir -p /app/backend/recordings && \
    groupadd -r appuser && \
    useradd -r -g appuser appuser && \
    chown -R appuser:appuser /app

# 阶段 4: 切换到非特权用户
USER appuser

# 暴露 Flask 默认端口 (仅元数据声明)
EXPOSE 5000

# 启动命令：使用 Gunicorn 运行 Flask 应用
# --bind: 监听容器所有网卡的 5000 端口
# --workers: 建议设置为 (2 * CPU核心数) + 1
CMD ["gunicorn", "--bind", "0.0.0.0:5000", "--workers", "3", "--timeout", "120", "backend.app:app"]
