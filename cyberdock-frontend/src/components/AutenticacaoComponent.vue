<template>
    <div class="auth-container">
        <Toast />
        <div v-if="loggedInUser" class="logged-in-view">
            <h2 class="title">Bem-vindo(a)!</h2>
            <p class="subtitle">Você está logado como:</p>
            <p class="user-email">{{ loggedInUser.email }}</p>
            <button @click="logout" class="logout-button">
                Sair
            </button>
        </div>

        <div v-else class="form-container">
            <h2 class="form-title">{{ isLoginView ? 'Login' : 'Criar Conta' }}</h2>
            <p class="form-subtitle">{{ isLoginView ? 'Bem-vindo(a) de volta!' : 'É rápido e fácil!' }}</p>

            <form @submit.prevent="handleSubmit">
                <transition @before-enter="beforeEnter" @enter="enter" @leave="leave">
                    <div v-if="!isLoginView" class="input-group" key="name">
                        <label for="name" class="label">Nome</label>
                        <input v-model="formData.name" id="name" type="text" required class="input-field">
                    </div>
                </transition>
                <div class="input-group">
                    <label for="email" class="label">Email</label>
                    <input v-model="formData.email" id="email" type="email" required class="input-field">
                </div>
                <div class="input-group">
                    <label for="password" class="label">Senha</label>
                    <input v-model="formData.password" id="password" type="password" required class="input-field">
                </div>
                <button type="submit" class="submit-button" :disabled="isLoading">
                    <span v-if="isLoading" class="loader"></span>
                    <span v-else>{{ isLoginView ? 'Entrar' : 'Cadastrar' }}</span>
                </button>
            </form>

            <p class="toggle-text">
                {{ isLoginView ? 'Não tem uma conta?' : 'Já tem uma conta?' }}
                <a @click.prevent="toggleMode" href="#" class="toggle-link">
                    {{ isLoginView ? 'Cadastre-se' : 'Faça login' }}
                </a>
            </p>
        </div>
    </div>
</template>

<script setup>
import { ref, reactive, onMounted, watch } from 'vue';
import { useRouter } from 'vue-router';
import { gsap } from 'gsap';
import AlertService from '../services/AlertService';
import Toast from './ToastComponent.vue';
import { useAuth } from '@/composables/useAuth';

const { loggedInUser, login, register, logout: authLogout } = useAuth();
const router = useRouter();
const isLoginView = ref(true);
const isLoading = ref(false);
const formData = reactive({ name: '', email: '', password: '' });

// Redireciona para o dashboard sempre que loggedInUser for preenchido
onMounted(() => {
  if (loggedInUser.value) {
    router.push('/dashboard');
  }
});

// Observa mudanças em loggedInUser para redirecionar imediatamente após login/registro
watch(() => loggedInUser.value, (val) => {
  if (val) {
    router.push('/dashboard');
  }
});

const clearForms = () => {
    formData.name = '';
    formData.email = '';
    formData.password = '';
};

// Verifica se o usuário já está logado ao montar o componente
// Removido redirecionamento duplicado para dashboard

const toggleMode = () => {
    isLoginView.value = !isLoginView.value;
};

const handleSubmit = async () => {
    isLoading.value = true;
    try {
        if (isLoginView.value) {
            await login(formData.email, formData.password);
            AlertService.success('Login realizado com sucesso!');
        } else {
            await register(formData.name, formData.email, formData.password);
            AlertService.success('Conta criada com sucesso!');
            // Após o registro, muda para a tela de login
            isLoginView.value = true; 
        }
        clearForms();
    } catch (error) {
        // O erro já vem tratado do composable de autenticação
        AlertService.error(error.message || 'Ocorreu um erro.');
    } finally {
        isLoading.value = false;
    }
};

const logout = async () => {
    await authLogout();
    AlertService.info('Você saiu da sua conta.');
    // A lógica de redirecionamento já está no composable
};

// Animações GSAP (sem alteração)
const beforeEnter = (el) => {
    gsap.set(el, { opacity: 0, y: -20 });
};
const enter = (el, done) => {
    gsap.to(el, { opacity: 1, y: 0, duration: 0.3, onComplete: done });
};
const leave = (el, done) => {
    gsap.to(el, { opacity: 0, y: -20, duration: 0.3, onComplete: done });
};
</script>

<style scoped>
/* Os estilos permanecem os mesmos */
.auth-container {
    background-color: #ffffff;
    padding: 2.5rem;
    border-radius: 1rem;
    border: 1px solid #e5e7eb;
    box-shadow: 0 4px 6px -1px rgb(0 0 0 / 0.1), 0 2px 4px -2px rgb(0 0 0 / 0.1);
    position: relative;
    overflow: hidden;
    max-width: 420px;
    width: 100%;
    box-sizing: border-box;
}

.logged-in-view {
    text-align: center;
    color: #374151;
}

.title {
    font-size: 1.75rem;
    font-weight: 700;
    color: #111827;
    margin-bottom: 0.75rem;
}

.subtitle {
    color: #4b5563;
    margin-bottom: 1.5rem;
}

.user-email {
    font-weight: 600;
    color: #4f46e5;
    word-break: break-all;
    background-color: #f0f0f8;
    padding: 0.5rem 1rem;
    border-radius: 0.5rem;
}

.logout-button {
    margin-top: 2rem;
    width: 100%;
    background-color: #ef4444;
    color: #ffffff;
    padding: 0.75rem 0;
    border-radius: 0.5rem;
    border: none;
    cursor: pointer;
    font-weight: 600;
    transition: all 0.2s ease-in-out;
}

.logout-button:hover {
    background-color: #dc2626;
    transform: translateY(-2px);
    box-shadow: 0 4px 8px rgba(239, 68, 68, 0.2);
}

.form-container {
    position: relative;
}

.form-title {
    font-size: 1.75rem;
    font-weight: 800;
    text-align: start;
    color: #1f2937;
    margin-bottom: 0.5rem;
}

.form-subtitle {
    text-align: start;
    color: #6b7280;
    margin-bottom: 2rem;
}

.input-group {
    margin-bottom: 1.25rem;
}

.label {
    display: block;
    font-size: 0.875rem;
    font-weight: 600;
    color: #374151;
    margin-bottom: 0.5rem;
    text-align: left;
}

.input-field {
    width: 100%;
    padding: 0.75rem 1rem;
    border: 1px solid #d1d5db;
    border-radius: 0.5rem;
    box-sizing: border-box;
    background-color: #f9fafb;
    color: #1f2937;
    transition: border-color 0.2s, box-shadow 0.2s;
}

.input-field:focus {
    outline: none;
    border-color: #6366f1;
    box-shadow: 0 0 0 3px rgba(99, 102, 241, 0.3);
}

.submit-button {
    width: 100%;
    background-color: #6366f1;
    color: #ffffff;
    padding: 0.875rem 0;
    border-radius: 0.5rem;
    border: none;
    cursor: pointer;
    font-weight: 600;
    font-size: 1rem;
    transition: all 0.2s ease-in-out;
    display: flex;
    align-items: center;
    justify-content: center;
    position: relative;
}

.submit-button:disabled {
    background-color: #a5b4fc;
    cursor: not-allowed;
}

.submit-button:hover:not(:disabled) {
    background-color: #4f46e5;
    transform: translateY(-2px);
    box-shadow: 0 4px 10px rgba(79, 70, 229, 0.2);
}

.loader {
    border: 2px solid #ffffff;
    border-top: 3px solid transparent;
    border-radius: 50%;
    width: 10px;
    height: 10px;
    animation: spin 1s linear infinite;
}

@keyframes spin {
    0% {
        transform: rotate(0deg);
    }

    100% {
        transform: rotate(360deg);
    }
}

.toggle-text {
    text-align: center;
    font-size: 0.875rem;
    color: #4b5563;
    margin-top: 1.5rem;
}

.toggle-link {
    font-weight: 600;
    color: #6366f1;
    text-decoration: none;
    cursor: pointer;
    transition: color 0.2s;
}

.toggle-link:hover {
    color: #4338ca;
}
</style>
