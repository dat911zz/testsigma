# Stage 1: Build the Angular app
FROM node:16 as build
WORKDIR /app
COPY package*.json ./
RUN set NODE_OPTIONS=--openssl-legacy-provider --max_old_space_size=4096
RUN npm install --legacy-peer-deps
COPY . .
RUN npx ng build --source-map --configuration=docker

# The built files will be in /app/dist/<your-angular-app>