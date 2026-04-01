# Etapa 1: Construir o site Vue.js
FROM node:18-alpine AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
RUN npm run build

# Etapa 2: Servir com Nginx configurado para SPA
FROM nginx:alpine
# Remove a config padrão
RUN rm /etc/nginx/conf.d/default.conf
# Copia nossa config personalizada
COPY nginx.conf /etc/nginx/conf.d/default.conf
# Copia os arquivos compilados do Vue
COPY --from=build /app/dist /usr/share/nginx/html
EXPOSE 80
CMD ["nginx", "-g", "daemon off;"]
