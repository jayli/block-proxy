




FROM node:22-alpine

WORKDIR /app

COPY package.json ./

CMD ["npm", "run", "clear"]

COPY . ./

ENV PATH=/usr/local/bin:$PATH

RUN npm install --registry=https://registry.npmmirror.com
#RUN corepack enable && pnpm i --frozen-lockfile --registry=https://registry.npmmirror.com

EXPOSE 3000
EXPOSE 8001
EXPOSE 8002

CMD ["npm", "run", "dev"]

#RUN mkdir /app/videos

#ENTRYPOINT ["/app/bin/recorder.js"]
#CMD ["npm", "start"]
