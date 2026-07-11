FROM node:22-alpine

WORKDIR /app

ENV NODE_ENV=production
ENV HOST=0.0.0.0
ENV PORT=4173
ENV REPORTS_DB_PATH=/app/reports-data/qa-report.sqlite

COPY --chown=node:node package.json ./
COPY --chown=node:node server.js app.js jira-markup-import.js index.html styles.css favicon.svg ./
RUN mkdir -p /app/reports-data && chown -R node:node /app/reports-data

USER node

EXPOSE 4173

HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:4173/api/health').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"

CMD ["node", "server.js"]
