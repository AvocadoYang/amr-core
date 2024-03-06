
FROM node:20
# RUN apt-get update && apt-get install -y --no-install-recommends

WORKDIR /usr/src/app

COPY package*.json ./

RUN yarn install

EXPOSE 6060

COPY . .

CMD ["yarn","start"]
# CMD ["yarn", "prisma", "db", "push"]


