docker run --init -d --restart=unless-stopped -e TZ=Asia/Shanghai --publish 3000:3000 --publish 8001:8001 --publish 8002:8002 --name block-proxy block-proxy

