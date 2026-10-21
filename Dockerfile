# KlipFox server with the link downloader: Node 20 + yt-dlp + ffmpeg
# Render: New > Web Service > this folder > "Docker". Set the environment variables there.
FROM node:20-slim
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg python3 ca-certificates curl \
 && curl -L https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp -o /usr/local/bin/yt-dlp \
 && chmod a+rx /usr/local/bin/yt-dlp \
 && apt-get purge -y curl && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package.json server.js ./
ENV NODE_ENV=production PORT=8000
EXPOSE 8000
# keep yt-dlp current: sites change often
CMD yt-dlp -U >/dev/null 2>&1; node server.js
