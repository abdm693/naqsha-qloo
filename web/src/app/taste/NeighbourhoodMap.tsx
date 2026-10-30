/**
 * The neighbourhood on a map: the plot as a pin, and the places people love around it as small photo markers. Hovering
 * an idea elsewhere highlights the places it came from (`highlight`). Vector tiles from OpenFreeMap (no key), with the
 * buildings raised so the street reads as a place. MapLibre is loaded only when a map is on screen.
 */
import { useEffect, useRef, useState } from "react";
import type { GeoPoint, LocalPlace } from "@contracts/api-types";
import "maplibre-gl/dist/maplibre-gl.css";

type Maplibre = typeof import("maplibre-gl");
const STYLE = "https://tiles.openfreemap.org/styles/positron";

export function NeighbourhoodMap({ center, places, highlight, label, className }: {
  center: GeoPoint; places: LocalPlace[]; highlight?: string[]; label: string; className?: string;
}) {
  const box = useRef<HTMLDivElement>(null);
  const markers = useRef<Map<string, HTMLElement>>(new Map());
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let map: import("maplibre-gl").Map | null = null;
    let gone = false;
    // The card can still be growing when the map starts: follow its size.
    const watch = new ResizeObserver(() => map?.resize());
    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    void import("maplibre-gl").then((ml: Maplibre) => {
      if (gone || !box.current) return;
      map = new ml.Map({
        container: box.current,
        style: STYLE,
        center: [center.lon, center.lat],
        zoom: 14.2,
        pitch: 48,
        bearing: -12,
        attributionControl: { compact: true },
        cooperativeGestures: true,
      });
      map.addControl(new ml.NavigationControl({ showCompass: false }), "top-right");
      watch.observe(box.current);
      map.on("error", (e) => {
        if (String(e.error?.message || "").includes("style")) setFailed(true);
      });
      map.on("load", () => {
        if (!map) return;
        map.resize();
        // Raise the buildings: the street reads as a place, not a diagram.
        if (map.getLayer("building")) {
          map.addLayer({
            id: "building-3d", type: "fill-extrusion", source: "openmaptiles", "source-layer": "building", minzoom: 13,
            paint: {
              "fill-extrusion-color": "#e7e1d8",
              "fill-extrusion-height": ["coalesce", ["get", "render_height"], 6],
              "fill-extrusion-base": ["coalesce", ["get", "render_min_height"], 0],
              "fill-extrusion-opacity": 0.85,
            },
          }, "building");
        }
        // Stay on the plot at street level (buildings show from 14): as far out as the places need, never a city view.
        const bounds = new ml.LngLatBounds([center.lon, center.lat], [center.lon, center.lat]);
        places.forEach((p) => bounds.extend([p.lon, p.lat]));
        const cam = places.length ? map.cameraForBounds(bounds, { padding: 40 }) : null;
        const zoom = Math.max(14.1, Math.min(cam?.zoom ?? 15, 15.6));
        map.easeTo({ center: [center.lon, center.lat], zoom, pitch: 52, bearing: -14, duration: reduce ? 0 : 1800 });
      });

      for (const p of places) {
        // MapLibre positions the marker element with its own transform: the button inside it is what scales.
        const mk = document.createElement("div");
        const el = document.createElement("button");
        mk.appendChild(el);
        el.type = "button";
        el.className = "nbh-place";
        el.setAttribute("aria-label", `${p.name}${p.category ? `, ${p.category}` : ""}`);
        el.innerHTML = p.image
          ? `<img src="${p.image}" alt="" loading="lazy" referrerpolicy="no-referrer" />`
          : `<span class="nbh-dot"></span>`;
        const popup = new ml.Popup({ offset: 18, closeButton: false, className: "nbh-popup", maxWidth: "240px" }).setHTML(
          `<strong>${esc(p.name)}</strong>${p.category ? `<span>${esc(p.category)}</span>` : ""}` +
            (p.feel.length ? `<em>${p.feel.slice(0, 4).map(esc).join(" · ")}</em>` : ""),
        );
        el.addEventListener("mouseenter", () => map && popup.setLngLat([p.lon, p.lat]).addTo(map));
        el.addEventListener("mouseleave", () => popup.remove());
        el.addEventListener("focus", () => map && popup.setLngLat([p.lon, p.lat]).addTo(map));
        el.addEventListener("blur", () => popup.remove());
        new ml.Marker({ element: mk }).setLngLat([p.lon, p.lat]).addTo(map);
        markers.current.set(p.name, el);
      }

      const pin = document.createElement("div");
      pin.className = "nbh-pin";
      pin.setAttribute("role", "img");
      pin.setAttribute("aria-label", "Your plot");
      pin.innerHTML = `<span class="nbh-pin-pulse"></span><span class="nbh-pin-head"><svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="white" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 10.5 12 3l9 7.5"/><path d="M5 9.5V21h14V9.5"/></svg></span><span class="nbh-pin-label">Your plot</span>`;
      new ml.Marker({ element: pin, anchor: "bottom" }).setLngLat([center.lon, center.lat]).addTo(map);
    }).catch(() => setFailed(true));
    return () => {
      gone = true;
      watch.disconnect();
      markers.current.clear();
      map?.remove();
    };
  }, [center.lat, center.lon, places]);

  useEffect(() => {
    const on = new Set(highlight || []);
    markers.current.forEach((el, name) => {
      el.classList.toggle("is-lit", on.has(name));
      el.classList.toggle("is-dim", on.size > 0 && !on.has(name));
    });
  }, [highlight]);

  return (
    <div className={className} role="region" aria-label={label}>
      {failed ? (
        <div className="grid size-full place-items-center bg-surface-2 text-small text-ink-3">The map couldn't load. The places are listed alongside.</div>
      ) : (
        <div ref={box} className="size-full" />
      )}
    </div>
  );
}

function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}
