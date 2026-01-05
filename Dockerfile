FROM apify/actor-node:22

COPY --chown=myuser:myuser package*.json ./
RUN npm i --omit=dev && rm -r ~/.npm || true

COPY --chown=myuser:myuser . ./

CMD npm start --silent
