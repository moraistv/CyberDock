const AlertService = {
  success(message) {
    this.showToast(message, 'success');
  },

  error(message) {
    this.showToast(message, 'error');
  },

  warning(message) {
    this.showToast(message, 'warning');
  },

  info(message) {
    this.showToast(message, 'info');
  },

  showToast(message, type) {
    const id = `toast-${Date.now()}-${Math.floor(Math.random() * 1000)}`;
    window.dispatchEvent(new CustomEvent('show-toast', {
      detail: { id, message, type }
    }));
  }
};

export default AlertService;