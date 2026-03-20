// Cloudflare Worker - Oref Alerts History Proxy
// Deploy to Cloudflare Workers to bypass IP-based blocking from GitHub Actions
// Usage: https://<worker-name>.<account>.workers.dev/

const OREF_URL = "https://alerts-history.oref.org.il/Shared/Ajax/GetAlarmsHistory.aspx?lang=he&mode=1";

export default {
  async fetch(request) {
    const response = await fetch(OREF_URL, {
      headers: {
        "Referer": "https://www.oref.org.il/",
        "X-Requested-With": "XMLHttpRequest",
        "User-Agent": "Mozilla/5.0",
      },
    });

    const data = await response.text();
    return new Response(data, {
      status: response.status,
      headers: {
        "Content-Type": "application/json; charset=utf-8",
        "Access-Control-Allow-Origin": "*",
        "Cache-Control": "no-cache, max-age=0",
      },
    });
  },
};
