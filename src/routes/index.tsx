import { useEffect, useRef } from "react";
import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/")({ component: Home });

function Home() {
  const hostRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    let cancelled = false;
    const added: HTMLElement[] = [];

    (async () => {
      host.textContent = "Opening Kin Studio…";
      const res = await fetch("/phone.html", { cache: "no-store" });
      const html = await res.text();
      if (cancelled) return;
      const doc = new DOMParser().parseFromString(html, "text/html");

      doc.querySelectorAll("style").forEach((style) => {
        const s = document.createElement("style");
        s.setAttribute("data-ks-phone", "1");
        s.textContent = style.textContent;
        document.head.appendChild(s);
        added.push(s);
      });
      doc.querySelectorAll('link[rel="apple-touch-icon"], link[rel="manifest"]').forEach((link) => {
        const l = document.createElement("link");
        l.rel = link.getAttribute("rel") || "";
        l.href = (link as HTMLLinkElement).href;
        l.setAttribute("data-ks-phone", "1");
        document.head.appendChild(l);
        added.push(l);
      });
      doc.querySelectorAll('meta[name^="apple-mobile"], meta[name="mobile-web-app-capable"]').forEach((meta) => {
        const m = document.createElement("meta");
        m.name = meta.getAttribute("name") || "";
        m.content = meta.getAttribute("content") || "";
        m.setAttribute("data-ks-phone", "1");
        document.head.appendChild(m);
        added.push(m);
      });

      const kids = Array.from(doc.body.childNodes).filter(
        (n) => n.nodeName !== "SCRIPT",
      );
      host.replaceChildren(...kids.map((n) => n.cloneNode(true)));

      for (const old of Array.from(doc.querySelectorAll("script"))) {
        if (cancelled) return;
        const s = document.createElement("script");
        s.setAttribute("data-ks-phone", "1");
        const type = old.getAttribute("type");
        if (type) s.type = type;
        const src = old.getAttribute("src");
        if (src) {
          s.src = src;
          await new Promise<void>((resolve) => {
            s.onload = () => resolve();
            s.onerror = () => resolve();
            document.body.appendChild(s);
          });
        } else {
          s.textContent = old.textContent;
          document.body.appendChild(s);
        }
        added.push(s);
      }
    })().catch(() => {
      if (cancelled || !host) return;
      host.innerHTML =
        '<p style="padding:16px">Could not open Kin Studio. <a href="/phone.html" style="color:#6b8f7e">Open app</a></p>';
    });

    return () => {
      cancelled = true;
      added.forEach((n) => n.remove());
    };
  }, []);

  return (
    <div ref={hostRef} className="min-h-dvh bg-[#0f1115] p-6 text-[#e8eaed]">
      Opening Kin Studio…
    </div>
  );
}
