# G20 Proxy — Cotações e Dividendos

Servidor serverless na Vercel para contornar CORS do Yahoo Finance.

## Endpoints

### Cotações
```
GET /api/quote?symbol=AAPL
GET /api/quote?symbol=AAPL,MSFT,NVDA
GET /api/quote?symbol=PETR4.SA,VALE3.SA
```

### Dividendos históricos
```
GET /api/dividends?symbol=MSFT&from=2020-01-01
GET /api/dividends?symbol=PETR4.SA&from=2018-01-01
```

## Deploy na Vercel (gratuito)

1. Crie conta em vercel.com
2. Instale o CLI: `npm i -g vercel`
3. Rode: `vercel deploy`
4. Pronto! URL gerada ex: `https://g20-proxy.vercel.app`

## Uso na carteira G20

Configure a URL do proxy nas variáveis do carteira.html:
```javascript
var PROXY_URL = 'https://g20-proxy.vercel.app';
```
