const form = document.querySelector('#checkout-form');
const message = document.querySelector('#form-message');
if (form) {
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    const button = form.querySelector('button[type="submit"]');
    button.disabled = true;
    button.textContent = 'Opening secure checkout…';
    message.textContent = '';
    try {
      const response = await fetch('/api/create-checkout-session', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: form.elements.email.value.trim() }),
      });
      const result = await response.json();
      if (!response.ok || !result.url) throw new Error(result.error || 'Checkout could not be opened.');
      window.location.assign(result.url);
    } catch (error) {
      message.textContent = error.message || 'Please try again or call us for help.';
      button.disabled = false;
      button.innerHTML = 'Start free trial <span>→</span>';
    }
  });
}
const year = document.querySelector('#year');
if (year) year.textContent = new Date().getFullYear();
