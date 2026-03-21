export default {
  async fetch(request) {
    const urls = [
      "https://alerts-history.oref.org.il/Shared/Ajax/GetAlarmsHistory.aspx?lang=he&mode=1",
      "https://www.oref.org.il/warningMessages/alert/History/AlertsHistory.json",
    ];

    for (const url of urls) {
      try {
        const resp = await fetch(url, {
          headers: {
            "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
            "Accept-Language": "he-IL,he;q=0.9,en-US;q=0.8,en;q=0.7",
            "Referer": "https://www.oref.org.il/",
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.0.0 Safari/537.36",
          },
        });

        if (!resp.ok) continue;

        const text = await resp.text();
        if (!text.trim().startsWith("[")) continue;

        return new Response(text, {
          headers: {
            "Content-Type": "application/json; charset=utf-8",
            "Access-Control-Allow-Origin": "*",
          },
        });
      } catch (e) {
        continue;
      }
    }

    return new Response('{"error":"All endpoints failed"}', {
      status: 502,
      headers: { "Content-Type": "application/json" },
    });
  },
};
