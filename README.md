# Bilstudio Server (Render)

Express-app som tar imot kontaktskjema og sender e-post (til Bilstudio + bekreftelse til kunde).

## Miljøvariabler (Render → Environment)

```
SMTP_HOST=smtp.gmail.com
SMTP_PORT=587
SMTP_USER=Oliver@bil-studio.no
SMTP_PASS=dkqnnktliiexjopn
MAIL_FROM=Oliver@bil-studio.no
MAIL_TO=Post@bil-studio.no
ORIGIN=https://boisterous-travesseiro-bc8845.netlify.app
```

> MAIL_FROM må bruke samme konto som SMTP_USER.

## Render

- Build command: `npm install`
- Start command: `node server.js`
- Region: EU (Frankfurt)
