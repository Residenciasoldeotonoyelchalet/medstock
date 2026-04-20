const { initializeApp, cert } = require('firebase-admin/app');
const { getFirestore } = require('firebase-admin/firestore');

const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
initializeApp({ credential: cert(serviceAccount) });
const db = getFirestore();

async function main() {
  const today = new Date().toISOString().slice(0, 10);
  console.log('Ejecutando descuento diario para:', today);

  const cfgRef = db.collection('config').doc('dailyDiscount');
  const cfg = await cfgRef.get();
  if (cfg.exists && cfg.data().lastDate === today) {
    console.log('Ya se realizó el descuento hoy. Saliendo.');
    return;
  }

  const medsSnap = await db.collection('meds').get();
  const meds = medsSnap.docs.map(d => ({ id: d.id, ...d.data() }));

  const hoy = new Date();
  hoy.setHours(0,0,0,0);
  const diasMap = { lun:1, mar:2, mie:3, jue:4, vie:5, sab:6, dom:0 };

  function debeTomarsHoy(med) {
    if (!med.frecuencia || med.frecuencia === 'diario') return true;
    if (med.frecuencia === 'alternos') {
      if (!med.fechaInicio) return true;
      const inicio = new Date(med.fechaInicio + 'T00:00:00');
      const diff = Math.round((hoy - inicio) / 86400000);
      return diff % 2 === 0;
    }
    if (med.frecuencia === 'especificos') {
      const dias = (med.diasSemana || []).map(d => diasMap[d]);
      return dias.includes(hoy.getDay());
    }
    if (med.frecuencia === 'cada_x_dias') {
      if (!med.fechaInicio) return true;
      const inicio = new Date(med.fechaInicio + 'T00:00:00');
      const diff = Math.round((hoy - inicio) / 86400000);
      return diff % (med.cadaXDias || 1) === 0;
    }
    return true;
  }

  function getDosisdiaria(med) {
    if (!med.horarios || med.horarios.length === 0) return 0;
    return med.horarios.reduce((sum, h) => sum + (parseFloat(h.dosis) || 0), 0);
  }

  function getStatus(med) {
    if (med.fechaFin) {
      const fin = new Date(med.fechaFin + 'T00:00:00');
      if (hoy > fin) return 'finalizado';
    }
    return 'ok';
  }

  let count = 0;
  const batch = db.batch();

  for (const med of meds) {
    if (med.treatment !== 'prolongado') continue;
    if (med.sos) continue;
    if ((med.qty || 0) <= 0) continue;
    if (getStatus(med) === 'finalizado') continue;
    if (!debeTomarsHoy(med)) continue;
    const dosis = getDosisdiaria(med);
    if (dosis <= 0) continue;
    const newQty = Math.max(0, (med.qty || 0) - Math.min(dosis, med.qty));
    batch.update(db.collection('meds').doc(med.id), { qty: newQty });
    count++;
  }

  await batch.commit();
  await cfgRef.set({ lastDate: today, by: 'automático (sistema)' });
  console.log('Descuento aplicado a ' + count + ' medicamentos.');
}

main().catch(e => { console.error(e); process.exit(1); });
