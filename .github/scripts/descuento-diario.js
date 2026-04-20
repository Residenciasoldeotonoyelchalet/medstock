const { initializeApp, cert } = require('firebase-admin/app');
const { getFirestore } = require('firebase-admin/firestore');
const nodemailer = require('nodemailer');

const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
initializeApp({ credential: cert(serviceAccount) });
const db = getFirestore();

const transporter = nodemailer.createTransport({
  service: 'gmail',
  auth: {
    user: 'camila.ciaf@gmail.com',
    pass: process.env.GMAIL_PASSWORD
  }
});

async function sendAlert(subject, text) {
  try {
    await transporter.sendMail({
      from: 'MedStock <camila.ciaf@gmail.com>',
      to: 'camila.micol@hotmail.com',
      cc: 'camila.ciaf@gmail.com',
      subject: subject,
      text: text
    });
    console.log('Email de alerta enviado.');
  } catch(e) {
    console.error('Error enviando email:', e.message);
  }
}

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
  const meds = medsSnap.docs.map(d => ({ docId: d.id, ...d.data() }));

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
    if (!med.docId) continue;
    if (med.treatment !== 'prolongado') continue;
    if (med.sos) continue;
    if ((med.qty || 0) <= 0) continue;
    if (getStatus(med) === 'finalizado') continue;
    if (!debeTomarsHoy(med)) continue;
    const dosis = getDosisdiaria(med);
    if (dosis <= 0) continue;
    const newQty = Math.max(0, (med.qty || 0) - Math.min(dosis, med.qty));
    batch.update(db.collection('meds').doc(med.docId), { qty: newQty });
    count++;
  }

  await batch.commit();
  await cfgRef.set({ lastDate: today, by: 'automatico (sistema)' });
  console.log('Descuento aplicado a ' + count + ' medicamentos.');
}

main().catch(async e => {
  console.error('ERROR:', e);
  await sendAlert(
    '⚠️ MedStock — Error en el descuento automático',
    'El descuento automático de medicación del ' + new Date().toISOString().slice(0,10) + ' NO se realizó.\n\nError: ' + e.message + '\n\nIngresá a MedStock y revisá el stock manualmente.'
  );
  process.exit(1);
});
