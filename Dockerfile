




FROM node:18-alpine

WORKDIR /app

# 复制依赖文件
COPY package.json pnpm-lock.yaml ./

CMD ["npm", "run", "clear"]

COPY . ./

ENV PATH=/usr/local/bin:$PATH

RUN npm install -g pnpm --registry=https://registry.npmmirror.com
RUN pnpm install --force --registry=https://registry.npmmirror.com
# RUN corepack enable && pnpm i --frozen-lockfile --registry=https://registry.npmmirror.com

EXPOSE 3000
EXPOSE 8001
EXPOSE 8002

CMD ["npm", "run", "dev"]

#RUN mkdir /app/videos

#ENTRYPOINT ["/app/bin/recorder.js"]
#CMD ["npm", "start"]
