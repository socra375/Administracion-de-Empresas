# vendor/

`neon-supabase.js` es el cliente de Neon (`@neon/neon-js` 0.10.2, adaptador compatible con
supabase-js) empaquetado en un solo archivo para el navegador. La app no tiene paso de
compilación, así que se incluye ya empaquetado en vez de cargarlo desde un CDN: funciona sin
depender de un tercero y queda fijado a una versión concreta.

Expone `window.NeonSupabase.createClient(urlBase)`.

Para regenerarlo (por ejemplo, al subir de versión):

```sh
mkdir build && cd build && npm init -y
npm install @neon/neon-js@<versión> esbuild
cp ../vendor/neon-supabase.entry.js entry.js
npx esbuild entry.js --bundle --minify --format=iife --platform=browser \
  --target=es2020 --legal-comments=none --outfile=../vendor/neon-supabase.js
```
