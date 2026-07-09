const map = L.map("map", { zoomControl: false }).setView([45.52, -73.59], 13);
L.control.zoom({ position: "bottomright" }).addTo(map);

L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
  maxZoom: 19,
  attribution: "&copy; OpenStreetMap contributors",
}).addTo(map);

const summary = document.querySelector("#summary");
const buttons = document.querySelectorAll(".route-button");
let activeLayer;

window.addEventListener("load", () => map.invalidateSize({ pan: false }));

function formatDistance(meters) {
  if (meters == null) return null;
  return meters >= 1000 ? `${(meters / 1000).toFixed(1)} km` : `${Math.round(meters)} m`;
}

function popupHtml(properties) {
  const parts = [];
  if (properties.station_name) {
    parts.push(`<strong>${properties.label}</strong>`);
    parts.push(`<span>${properties.available_bikes} bikes, ${properties.available_ebikes} e-bikes</span>`);
    parts.push(`<span>${properties.available_docks} open docks</span>`);
  } else {
    parts.push(`<strong>${properties.label || "Route"}</strong>`);
    if (properties.distance_m != null) parts.push(`<span>${formatDistance(properties.distance_m)}</span>`);
    if (properties.comfort_score != null) parts.push(`<span>Comfort ${properties.comfort_score}/100</span>`);
  }
  return `<div class="map-popup">${parts.join("")}</div>`;
}

function routeCard(properties) {
  const color = properties.stroke || "#64748b";
  const metrics = [];
  if (properties.estimated_total_minutes != null) metrics.push(`<p><strong>${properties.estimated_total_minutes} min</strong> estimated total</p>`);
  if (properties.distance_m != null) metrics.push(`<p>${formatDistance(properties.distance_m)}${properties.comfort_score != null ? ` · comfort ${properties.comfort_score}/100` : ""}</p>`);
  if (properties.pickup_station) metrics.push(`<p>Pickup: ${properties.pickup_station}</p><p>Dropoff: ${properties.dropoff_station}</p>`);
  if (properties.note) metrics.push(`<p>${properties.note}</p>`);
  return `<article class="route-card" style="--route-color:${color}"><h2>${properties.label}</h2>${metrics.join("")}</article>`;
}

function pointStyle(feature, latlng) {
  const properties = feature.properties || {};
  return L.circleMarker(latlng, {
    radius: properties.id === "origin" || properties.id === "destination" ? 9 : 8,
    color: "#ffffff",
    weight: 3,
    fillColor: properties["marker-color"] || "#64748b",
    fillOpacity: 1,
  });
}

async function loadRoute(file) {
  if (activeLayer) map.removeLayer(activeLayer);
  summary.innerHTML = '<p class="empty-state">Loading route data...</p>';

  try {
    const response = await fetch(`../routes/${file}`, { cache: "no-store" });
    if (!response.ok) throw new Error(`Could not load ${file}`);
    const data = await response.json();
    const routeFeatures = data.features.filter((feature) => feature.geometry.type === "LineString" && feature.properties.comfort_score != null);
    summary.innerHTML = routeFeatures.map((feature) => routeCard(feature.properties)).join("") || '<p class="empty-state">No bike route found in this file.</p>';

    activeLayer = L.geoJSON(data, {
      style: (feature) => ({
        color: feature.properties.stroke || "#64748b",
        weight: feature.properties["stroke-width"] || 5,
        opacity: feature.properties["stroke-opacity"] || 0.8,
        dashArray: feature.properties["stroke-dasharray"] || null,
      }),
      pointToLayer: pointStyle,
      onEachFeature: (feature, layer) => layer.bindPopup(popupHtml(feature.properties || {})),
    }).addTo(map);

    map.invalidateSize({ pan: false });
    const bounds = activeLayer.getBounds();
    if (bounds.isValid()) map.fitBounds(bounds.pad(0.14));
  } catch (error) {
    summary.innerHTML = `<p class="empty-state">${error.message}. Run the router first, then reload this page.</p>`;
  }
}

buttons.forEach((button) => {
  button.addEventListener("click", () => {
    buttons.forEach((item) => item.classList.toggle("active", item === button));
    loadRoute(button.dataset.file);
  });
});

loadRoute("route_comparison.geojson");
