import { ref } from 'vue';

// Estado reativo compartilhado que indica se o modo admin está ativo.
const isAdminMode = ref(false);

/**
 * Composable para gerenciar o estado do "Modo Admin".
 * Permite que componentes diferentes saibam e alterem se a
 * interface de administração está ativa.
 */
export function useAdminMode() {
  
  /**
   * Ativa ou desativa o modo de administração.
   * @param {boolean} value - true para ativar, false para desativar.
   */
  const setAdminMode = (value) => {
    isAdminMode.value = value;
  };

  return {
    isAdminMode,
    setAdminMode,
  };
}
