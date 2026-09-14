const confirmation = new URLSearchParams(location.search).get("code");
if (confirmation) {
  const target = document.getElementById("deletion-status");
  target.className = "notice";
  target.textContent = "Checking your deletion confirmation…";
  fetch(`/api/meta/deletion-status?code=${encodeURIComponent(confirmation)}`, {credentials:"omit"})
    .then(async response => { if (!response.ok) throw new Error("This deletion confirmation was not found."); return response.json(); })
    .then(data => { target.textContent = `Facebook profile and authorization removal: ${data.status}. Confirmation created ${new Date(data.created_at).toLocaleDateString()}.`; })
    .catch(error => { target.textContent = error.message; });
}
