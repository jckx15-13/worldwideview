import { preload } from "react-dom";
import { AppShell } from "@/components/layout/AppShell";
import { DemoAdStrip } from "@/components/ads/DemoAdStrip";
import { globePreloadHrefs } from "@/lib/globe-preload";

export default function Home() {
  // AppShell loads GlobeView through `next/dynamic(..., { ssr: false })`, which
  // keeps 1.34 MB of compressed Cesium out of the prerendered HTML entirely — the
  // browser could not begin fetching it until hydration had already rendered the
  // component. Advertising the chunks here lets the preload scanner start them
  // alongside the framework bundle instead of 308 ms behind it.
  //
  // Deliberately on this route, not in layout.tsx: /login, /setup and /locked
  // share that layout and must not pull the globe.
  for (const href of globePreloadHrefs()) {
    preload(href, { as: "script" });
  }

  return (
    <div className="page-root">
      <AppShell />
      <DemoAdStrip />
    </div>
  );
}
