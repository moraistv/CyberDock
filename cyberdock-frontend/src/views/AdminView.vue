<template>
  <div class="admin-wrapper">
    <SidebarComponent />
    <div class="main-content">
      <TopbarComponent />
      <div class="content-area">
        <h1 class="title">Painel Administrativo</h1>
        <p class="subtitle">Bem-vindo à área de gerenciamento.</p>
      </div>
    </div>
  </div>
</template>

<script setup>
// Importa os componentes de layout necessários
import SidebarComponent from '../components/SidebarComponent.vue';
import TopbarComponent from '../components/TopbarComponent.vue';
</script>

<style scoped>
/* Importa a fonte padrão da aplicação */
@import url('https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap');

/* Estilo principal que organiza a sidebar e o conteúdo */
.admin-wrapper {
  display: flex;
  min-height: 100vh;
  margin: 0;
  padding: 0;
  font-family: 'Inter', sans-serif;
  background-color: #f3f4f6; /* Cor de fundo padrão */
}

/* Container para o conteúdo principal (topbar + área de conteúdo) */
.main-content {
  flex: 1; /* Faz com que ocupe todo o espaço restante */
  display: flex;
  flex-direction: column;
}

/* Área onde o conteúdo específico da página será exibido */
.content-area {
  flex: 1;
  padding: 2rem; /* Espaçamento interno para o conteúdo */
}

.title {
  font-size: 1.75rem;
  font-weight: 700;
  color: #1f2937;
  margin-bottom: 0.5rem;
}

.subtitle {
  font-size: 1rem;
  color: #4b5563;
  margin: 0;
}
</style>
