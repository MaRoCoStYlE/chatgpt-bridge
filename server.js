// server.js — Agentflow Bridge (Storefront "solide")

import express from 'express';
import fetch from 'node-fetch';
import fs from 'fs';

// ---------- Chargement du mapping depuis un fichier ----------
function loadMappingFromDisk() {
  try {
    const raw = fs.readFileSync('./mapping.json', 'utf8');
    const json = JSON.parse(raw);
    if (typeof json !== 'object' || Array.isArray(json)) throw new Error('mapping.json doit être un objet {SKU: id}');
    return json;
  } catch (e) {
    console.error('[mapping] mapping.json absent ou invalide:', e?.message);
    return {};
  }
}
let MAPPING = loadMappingFromDisk();

// Convertit ID numérique -> GID si nécessaire
function toVariantGID(id) {
  const s = String(id || '');
  return s.startsWith('gid://') ? s : `gid://shopify/ProductVariant/${s}`;
}

// ---------- App ----------
const app = express();
app.use(express.json({ limit: '200kb' }));

// Headers privacy AVANT les routes (sinon ça n’applique pas)
app.use((_, res, next) => {
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  next();
});

// Expose le mapping (lu depuis le fichier)
app.get('/mapping.json', (_req, res) => res.json(MAPPING));

// (Optionnel) Reload à chaud du mapping sans redeploy (protège-le plus tard si tu veux)
app.post('/admin/reload-mapping', (_req, res) => {
  MAPPING = loadMappingFromDisk();
  res.json({ ok: true, count: Object.keys(MAPPING).length });
});

// ---------- Config boutiques ----------
const SHOPS = {
  B: { domain: process.env.SHOP_B_DOMAIN, sfApi: process.env.SHOP_B_STOREFRONT_TOKEN },
  C: { domain: process.env.SHOP_C_DOMAIN || '', sfApi: process.env.SHOP_C_STOREFRONT_TOKEN || '' }
};

// ---------- Santé des shops ----------
async function healthCheck(shopKey) {
  const s = SHOPS[shopKey];
  if (!s?.domain || !s?.sfApi) return false;
  try {
    const r = await fetch(`https://${s.domain}/api/2024-10/graphql.json`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Shopify-Storefront-Access-Token': s.sfApi
      },
      body: JSON.stringify({ query: `query { shop { name } }` })
    });
    return r.ok;
  } catch {
    return false;
  }
}

async function pickTargetShop() {
  if (await healthCheck('B')) return 'B';
  if (await healthCheck('C')) return 'C';
  return null;
}

// ---------- Création du checkout via Storefront ----------
async function createCheckout(shopKey, payload) {
  const s = SHOPS[shopKey];
  const mutation = `
    mutation CreateCart($lines:[CartLineInput!], $attributes:[AttributeInput!], $note:String){
      cartCreate(input:{ lines:$lines, attributes:$attributes, note:$note }) {
        cart { id checkoutUrl }
        userErrors { field message }
      }
    }`;

  // Sécurise/simplifie le payload reçu du front A
  const lines = (payload?.lines || []).map(l => {
    const attrs = [];
    if (l?.properties && typeof l.properties === 'object') {
      for (const [k, v] of Object.entries(l.properties)) {
        if (v == null) continue;
        const t = typeof v;
        if (t === 'string' || t === 'number' || t === 'boolean') {
          attrs.push({ key: String(k), value: String(v) });
        }
      }
    }
    return {
      quantity: Number(l?.quantity) || 1,
      merchandiseId: toVariantGID(l?.id),           // <= conversion auto vers GID
      sellingPlanId: l?.selling_plan ? String(l.selling_plan) : null,
      attributes: attrs
    };
  });

  const attributes = [];
  if (payload?.attributes && typeof payload.attributes === 'object') {
    for (const [k, v] of Object.entries(payload.attributes)) {
      if (v == null) continue;
      attributes.push({ key: String(k), value: String(v) });
    }
  }

  const r = await fetch(`https://${s.domain}/api/2024-10/graphql.json`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Shopify-Storefront-Access-Token': s.sfApi
    },
    body: JSON.stringify({
      query: mutation,
      variables: { lines, attributes, note: payload?.note ? String(payload.note) : '' }
    })
  });

  const data = await r.json();
  const errs = data?.data?.cartCreate?.userErrors;
  if (errs?.length) throw new Error(errs.map(e => e.message).join('; '));
  const url = data?.data?.cartCreate?.cart?.checkoutUrl;
  if (!url) throw new Error('checkoutUrl introuvable');
  return url;
}

// ---------- Endpoint principal ----------
app.post('/bridge', async (req, res) => {
  try {
    if (!Array.isArray(req.body?.lines) || !req.body.lines.length) {
      return res.status(400).json({ error: 'lines manquantes' });
    }
    const target = await pickTargetShop();
    if (!target) return res.status(503).json({ error: 'Aucun shop disponible' });

    const checkoutUrl = await createCheckout(target, req.body);
    return res.redirect(302, checkoutUrl); // Referrer côté B = domaine du SaaS
  } catch (e) {
    return res.status(500).json({ error: e?.message || 'Erreur interne' });
  }
});

// ---------- Health ----------
app.get('/health', (_req, res) => res.json({ ok: true, ts: Date.now() }));

// ---------- Start ----------
const PORT = process.env.PORT || 8080;
app.listen(PORT, () => console.log('Bridge up on ' + PORT));
