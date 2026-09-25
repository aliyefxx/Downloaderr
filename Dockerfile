FROM python:3.10-slim

# FFmpeg, NodeJS, Deno və lazımi paketləri quraşdırırıq
RUN apt-get update && apt-get install -y ffmpeg nodejs curl unzip && rm -rf /var/lib/apt/lists/*

# Deno quraşdırırıq (YouTube JS challenge-ləri həll etmək üçün)
RUN curl -fsSL https://deno.land/install.sh | sh
ENV DENO_INSTALL="/root/.deno"
ENV PATH="$DENO_INSTALL/bin:$PATH"

WORKDIR /app

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt && pip install --no-cache-dir -U yt-dlp

COPY . .

ENV PORT=8000
EXPOSE 8000

CMD uvicorn backend.main:app --host 0.0.0.0 --port $PORT
