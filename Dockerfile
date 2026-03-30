# 使用轻量级 Python 镜像
FROM python:3.11-slim

WORKDIR /app

# 安装依赖（利用 Docker 缓存）
COPY backend/requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# 拷贝后端代码与前端静态资源
COPY backend/ ./backend/
COPY frontend/ ./frontend/
RUN mkdir -p /app/backend/recordings

# 环境变量配置
ENV FLASK_APP=backend/app.py
ENV FLASK_PORT=5000
ENV PYTHONUNBUFFERED=1

# 使用 Gunicorn 作为生产级 WSGI 运行
CMD ["gunicorn", "--bind", "0.0.0.0:5000", "--workers", "4", "backend.app:app"]
