import { createApp } from 'vue';
import App from './App.vue';
import router from './router';
import './firebase';
import './assets/main.css';

// Define explicitamente a feature flag para evitar o aviso
window.__VUE_PROD_HYDRATION_MISMATCH_DETAILS__ = false;

const app = createApp(App);

app.use(router);

app.mount('#app');