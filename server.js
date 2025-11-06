import express from 'express';
import fetch from 'node-fetch';

const app = express();
app.use(express.json({ limit: '200kb' }));

// Mapping servi en JSON depuis une variable d'env (simple et rapide)
const MAPPING = JSON.parse(process.env.MAPPING_JSON || '{}');
app.get('/mapping.json', (req, res) => res.json(MAPPING));

// Boutiques cible
const SHOPS = {
  B: { domain: process.env.SHOP_B_DOMAIN, sfApi: process.env.SHOP_B_STOREFRONT_TOKEN },
  C: { domain: process.env.SHOP_C_DOMAIN || '', sfApi: process.env.SHOP_C_STOREFRONT_TOKEN || '' }
};

async function healthCheck(shopKey){
  const s = SHOPS[shopKey];
  if (!s?.domain || !s?.sfApi) return false;
  try {
    const r = await fetch(`https://${s.domain}/api/2024-10/graphql.json`, {
      method: 'POST',
      headers: {
        'Content-Type':'application/json',
        'X-Shopify-Storefront-Access-Token': s.sfApi
      },
      body: JSON.stringify({ query: `query { shop { name } }` })
    });
    return r.ok;
  } catch { return false; }
}

async function pickTargetShop(){
  if (await healthCheck('B')) return 'B';
  if (await healthCheck('C')) return 'C';
  return null;
}

async function createCheckout(shopKey, payload){
  const s = SHOPS[shopKey];
  const mutation = `
    mutation CreateCart($lines:[CartLineInput!], $attributes:[AttributeInput!], $note:String){
      cartCreate(input:{ lines:$lines, attributes:$attributes, note:$note }) {
        cart { id checkoutUrl }
        userErrors { field message }
      }
    }`;

  const lines = (payload.lines||[]).map(l => ({
    quantity: l.quantity,
    merchandiseId: l.id,               // GID du variant sur la boutique cible
    sellingPlanId: l.selling_plan || null,
    attributes: l.properties ? Object.entries(l.properties).map(([k,v])=>({key:k, value:String(v)})) : []
  }));

  const attributes = payload.attributes
    ? Object.entries(payload.attributes).map(([k,v])=>({key:k, value:String(v)}))
    : [];

  const r = await fetch(`https://${s.domain}/api/2024-10/graphql.json`, {
    method: 'POST',
    headers: {
      'Content-Type':'application/json',
      'X-Shopify-Storefront-Access-Token': s.sfApi
    },
    body: JSON.stringify({ query: mutation, variables: { lines, attributes, note: payload.note || '' } })
  });
  const data = await r.json();
  const errs = data?.data?.cartCreate?.userErrors;
  if (errs?.length) throw new Error(errs.map(e=>e.message).join('; '));
  const url = data?.data?.cartCreate?.cart?.checkoutUrl;
  if (!url) throw new Error('checkoutUrl introuvable');
  return url;
}

app.post('/bridge', async (req, res) => {
  try {
    if (!Array.isArray(req.body?.lines) || !req.body.lines.length)
      return res.status(400).json({ error: 'lines manquantes' });

    const target = await pickTargetShop();
    if (!target) return res.status(503).json({ error: 'Aucun shop disponible' });

    const checkoutUrl = await createCheckout(target, req.body);
    return res.redirect(302, checkoutUrl); // referrer = ton domaine SaaS
  } catch (e){
    res.status(500).json({ error: e?.message || 'Erreur interne' });
  }
});

app.get('/health', (req,res)=> res.json({ ok:true, ts: Date.now() }));

// Header privacy de base
app.use((req,res,next)=>{
  res.setHeader('Referrer-Policy', 'no-referrer');
  next();
});

const PORT = process.env.PORT || 8080;
app.listen(PORT, ()=> console.log('Bridge up on '+PORT));
