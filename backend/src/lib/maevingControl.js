export async function getPlugStatus(ip) {
  const res = await fetch(`http://${ip}/rpc/Switch.GetStatus?id=0`, {
    signal: AbortSignal.timeout(5000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

export async function setPlugState(ip, on) {
  const res = await fetch(`http://${ip}/rpc/Switch.Set`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id: 0, on }),
    signal: AbortSignal.timeout(5000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}
