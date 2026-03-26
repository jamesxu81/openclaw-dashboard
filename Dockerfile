FROM node:20-alpine
WORKDIR /app

# Copy package files
COPY package.json ./

# Install dependencies
RUN npm install --production

# Copy source
COPY backend/ ./backend/
COPY frontend/ ./frontend/
COPY config.json ./

# Create data directory
RUN mkdir -p /app/data

# Expose port
EXPOSE 3001

# Environment defaults (override via docker run -e or docker-compose)
ENV MC_ADAPTER=stub
ENV PORT=3001

# Run sync then start server
CMD ["sh", "-c", "node backend/sync.js && node backend/index.js"]
