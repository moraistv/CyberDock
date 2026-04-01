<template>
  <div class="wrap">
    <div class="head">
      <div class="title">
        <h2>Gestão de SKUs Armazenados</h2>
        <span class="pill">{{ filteredSkus.length }} itens</span>
      </div>

      <div class="tools">
        <div class="search">
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <circle cx="11" cy="11" r="7" />
            <path d="M21 21l-4.3-4.3" />
          </svg>
          <input v-model.trim="query" type="search" placeholder="Buscar por SKU ou descrição…"
            aria-label="Buscar SKUs" />
        </div>

        <select v-model="pkgFilter" class="select" aria-label="Filtrar por tipo de pacote">
          <option value="">Todos os pacotes</option>
          <option value="Expedição Comum">Expedição Comum</option>
          <option value="Expedição Premium">Expedição Premium</option>
          <option value="(sem pacote)">(sem pacote)</option>
        </select>



        <div class="actions">
          <button @click="$emit('open-package-manager')" class="btn ghost">Gerenciar pacotes</button>
          <button @click="$emit('open-kit-manager')" class="btn ghost kit-manager">
            <svg  xmlns="http://www.w3.org/2000/svg"  width="20"  height="20"  viewBox="0 0 24 24"  fill="none"  stroke="currentColor"  stroke-width="2"  stroke-linecap="round"  stroke-linejoin="round"  class="icon icon-tabler icons-tabler-outline icon-tabler-package"><path stroke="none" d="M0 0h24v24H0z" fill="none"/><path d="M12 3l8 4.5l0 9l-8 4.5l-8 -4.5l0 -9l8 -4.5" /><path d="M12 12l8 -4.5" /><path d="M12 12l0 9" /><path d="M12 12l-8 -4.5" /><path d="M16 5.25l-8 4.5" /></svg>
            Gerenciar Kits
          </button>
          <button @click="$emit('add-sku')" class="btn primary">
            <svg viewBox="0 0 24 24" aria-hidden="true">
              <path d="M12 5v14M5 12h14" />
            </svg>
            Novo SKU
          </button>
        </div>
      </div>
    </div>

    <div v-if="error" class="alert error" role="alert">{{ error }}</div>

    <div class="table-container">
      <table class="sku-table" v-if="!isLoading && filteredSkus.length > 0">
        <thead>
          <tr>
            <th class="hierarchy-col">Hierarquia</th>
            <th>Descrição</th>
            <th>Tipo</th>
            <th>Tipo de Pacote</th>
            <th>Qtd.</th>
            <th>Volume Total (m³)</th>
            <th class="th-actions">Ações</th>
          </tr>
        </thead>
        <tbody ref="tbodyEl">
          <template v-for="item in filteredSkus" :key="`item-${item.id}-${item.type}`">
            <!-- SKU PAI -->
            <tr v-if="item.type === 'kit'" class="kit-parent-row">
              <td data-label="Hierarquia" class="hierarchy-col">
                <div class="kit-parent-item">
                  <button 
                    @click="toggleKitExpansion(item.id)" 
                    class="expand-toggle"
                    :class="{ 'expanded': expandedKits.includes(item.id) }"
                    :title="expandedKits.includes(item.id) ? 'Recolher' : 'Expandir'"
                  >
                    <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                      <polyline points="6 9 12 15 18 9"></polyline>
                    </svg>
                  </button>
                  <span class="hierarchy-icon"><svg  xmlns="http://www.w3.org/2000/svg"  width="24"  height="24"  viewBox="0 0 24 24"  fill="none"  stroke="currentColor"  stroke-width="2"  stroke-linecap="round"  stroke-linejoin="round"  class="icon icon-tabler icons-tabler-outline icon-tabler-packages"><path stroke="none" d="M0 0h24v24H0z" fill="none"/><path d="M7 16.5l-5 -3l5 -3l5 3v5.5l-5 3z" /><path d="M2 13.5v5.5l5 3" /><path d="M7 16.545l5 -3.03" /><path d="M17 16.5l-5 -3l5 -3l5 3v5.5l-5 3z" /><path d="M12 19l5 3" /><path d="M17 16.5l5 -3" /><path d="M12 13.5v-5.5l-5 -3l5 -3l5 3v5.5" /><path d="M7 5.03v5.455" /><path d="M12 8l5 -3" /></svg></span>
                  <span class="sku kit-parent-code">{{ item.sku }}</span>
                  <span class="children-count" v-if="item.children && item.children.length > 0">
                    ({{ item.children.length }} {{ item.children.length === 1 ? 'filho' : 'filhos' }})
                  </span>
                </div>
              </td>
              <td data-label="Descrição" class="ellipsis">{{ item.descricao }}</td>
              <td data-label="Tipo">
                <span class="kit-status" :class="item.ativo ? 'active' : 'inactive'">
                  SKU {{ item.ativo ? 'PAI' : 'INATIVO' }}
                </span>
              </td>
              <td data-label="Tipo de Pacote">
                <span v-if="item.package_type_name" :class="['badge', getPackageTypeClass(item.package_type_name)]">
                  {{ item.package_type_name }}
                </span>
                <span v-else class="muted">(sem pacote)</span>
              </td>
                           <td data-label="Qtd." class="no-quantity">
                <span class="kit-no-qty">—</span>
             </td>
              <td data-label="Volume Total (m³)">{{ calcularVolumeTotalKit(item).toFixed(4) }}</td>
              <td data-label="Ações" class="actions">
                <button @click="$emit('open-kit-manager')" class="icon" title="Gerenciar Kits">
                   <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9"/><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z"/></svg>
                </button>
              </td>
            </tr>
            
            <!-- SKUs FILHOS -->
            <tr 
              v-for="child in (item.children || [])" 
              :key="`child-${child.id}-${item.id}`" 
              class="child-sku-row"
              v-show="expandedKits.includes(item.id)"
            >
              <td data-label="Hierarquia" class="hierarchy-col">
                <div class="child-sku-item">
                  <div class="hierarchy-line"></div>
                  <span class="hierarchy-icon child-icon"><svg  xmlns="http://www.w3.org/2000/svg"  width="24"  height="24"  viewBox="0 0 24 24"  fill="none"  stroke="currentColor"  stroke-width="2"  stroke-linecap="round"  stroke-linejoin="round"  class="icon icon-tabler icons-tabler-outline icon-tabler-package"><path stroke="none" d="M0 0h24v24H0z" fill="none"/><path d="M12 3l8 4.5l0 9l-8 4.5l-8 -4.5l0 -9l8 -4.5" /><path d="M12 12l8 -4.5" /><path d="M12 12l0 9" /><path d="M12 12l-8 -4.5" /><path d="M16 5.25l-8 4.5" /></svg></span>
                  <span class="sku child-code">{{ child.quantity_per_kit }}x {{ child.sku }}</span>
                </div>
              </td>
              <td data-label="Descrição" class="ellipsis">
                {{ child.descricao }}
              </td>
              <td data-label="Tipo">
                <span class="child-badge">SKU FILHO</span>
              </td>
              <td data-label="Tipo de Pacote">
                <span v-if="child.package_type_name" :class="['badge', getPackageTypeClass(child.package_type_name)]">
                  {{ child.package_type_name }}
                </span>
                <span v-else class="muted">(sem pacote)</span>
              </td>
              <td data-label="Qtd.">
                <div class="quantity-cell">
                  <button @click="$emit('open-history', child)" class="qty">{{ child.quantidade }}</button>
                </div>
              </td>
              <td data-label="Volume Total (m³)">{{ calcularVolumePorSku(child).toFixed(4) }}</td>
              <td data-label="Ações" class="actions">
                <button 
                  @click="$emit('adjust-component-stock', child)" 
                  class="icon component-stock" 
                  title="Ajustar Estoque do Componente"
                >
                  <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                    <path d="M12 3l8 4.5v9l-8 4.5-8-4.5v-9L12 3"/>
                    <path d="M12 12l8-4.5"/>
                    <path d="M12 12v9"/>
                    <path d="M12 12L4 7.5"/>
                    <path d="M16 5.25L8 9.75"/>
                    <circle cx="18" cy="6" r="3"/>
                    <path d="M17 5h2"/>
                    <path d="M18 4v2"/>
                  </svg>
                </button>
                <button @click="$emit('edit-sku', child)" class="icon" title="Editar SKU">
                  <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M7 7h-1a2 2 0 0 0 -2 2v9a2 2 0 0 0 2 2h9a2 2 0 0 0 2 -2v-1"/><path d="M20.385 6.585a2.1 2.1 0 0 0 -2.97 -2.97l-8.415 8.385v3h3l8.385 -8.415z"/><path d="M16 5l3 3"/></svg>
                </button>
              </td>
            </tr>
            
            <!-- SKU Individual (Órfão) -->
            <tr v-if="item.type === 'orphan'" class="orphan-sku-row">
              <td data-label="Hierarquia" class="hierarchy-col">
                <div class="orphan-sku-item">
                  <span class="hierarchy-icon">📄</span>
                  <span class="sku orphan-code">{{ item.sku }}</span>
                </div>
              </td>
              <td data-label="Descrição" class="ellipsis">{{ item.descricao }}</td>
              <td data-label="Tipo">
                <span class="orphan-badge">Individual</span>
              </td>
              <td data-label="Tipo de Pacote">
                <span v-if="item.package_type_name" :class="['badge', getPackageTypeClass(item.package_type_name)]">
                  {{ item.package_type_name }}
                </span>
                <span v-else class="muted">(sem pacote)</span>
              </td>
              <td data-label="Qtd.">
                <div class="quantity-cell">
                  <button @click="$emit('open-history', item)" class="qty">{{ item.quantidade }}</button>
                </div>
              </td>
              <td data-label="Volume Total (m³)">{{ calcularVolumePorSku(item).toFixed(4) }}</td>
              <td data-label="Ações" class="actions">
                <button 
                  @click="$emit('adjust-stock', item)" 
                  class="icon" 
                  :disabled="!canAdjustStock(item)"
                  :title="getAdjustStockTooltip(item)"
                  :class="{ 'disabled-action': !canAdjustStock(item) }"
                >
                  <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3l8 4.5v9l-8 4.5-8-4.5v-9L12 3"/><path d="M12 12l8-4.5"/><path d="M12 12v9"/><path d="M12 12L4 7.5"/><path d="M16 5.25L8 9.75"/></svg>
                </button>
                <button 
                  v-if="activeKits.length > 0 && !isSkuComponent(item)" 
                  @click="$emit('connect-to-kit', item)" 
                  class="icon kit-connect" 
                  title="Conectar a Kit"
                >
                  <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M7 16.5l-5 -3l5 -3l5 3v5.5l-5 3z"/><path d="M2 13.5v5.5l5 3"/><path d="M7 16.545l5 -3.03"/><path d="M12 12l8-4.5"/><path d="M12 12v9"/></svg>
                </button>
                <button @click="$emit('edit-sku', item)" class="icon" title="Editar SKU">
                  <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M7 7h-1a2 2 0 0 0 -2 2v9a2 2 0 0 0 2 2h9a2 2 0 0 0 2 -2v-1"/><path d="M20.385 6.585a2.1 2.1 0 0 0 -2.97 -2.97l-8.415 8.385v3h3l8.385 -8.415z"/><path d="M16 5l3 3"/></svg>
                </button>
                <button 
                  @click="$emit('delete-sku', item)" 
                  class="icon danger" 
                  :disabled="!canDeleteSku(item)" 
                  :title="getDeleteTooltip(item)"
                  :class="{ 'disabled-action': !canDeleteSku(item) }"
                >
                  <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 7l16 0"/><path d="M10 11v6"/><path d="M14 11v6"/><path d="M5 7l1 12a2 2 0 0 0 2 2h8a2 2 0 0 0 2-2l1-12"/><path d="M9 7V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v3"/></svg>
                </button>
              </td>
            </tr>
          </template>
        </tbody>
      </table>

      <div v-if="isLoading" class="skeleton-wrapper">
        <div class="skeleton-row" v-for="n in 8" :key="n">
          <div class="sk anim" v-for="c in 6" :key="c" :style="{ width: `${[20, 35, 15, 10, 5, 15][c-1]}%` }"></div>
        </div>
      </div>

      <div v-if="!isLoading && !error && filteredSkus.length === 0" class="empty">
        <div class="emoji" aria-hidden="true">📦</div>
        <p>Nenhum SKU encontrado.</p>
        <button v-if="!query && !pkgFilter" class="btn primary" @click="$emit('add-sku')">
          <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 5v14M5 12h14"/></svg>
          Adicionar primeiro SKU
        </button>
      </div>
    </div>
  </div>
</template>

<script>
import { defineComponent, ref, computed, watch, nextTick } from 'vue'
import { gsap } from 'gsap'

export default defineComponent({
  name: 'SkuTable',
  props: {
    skus: { type: Array, required: true },
    activeKits: { type: Array, default: () => [] },
    isLoading: { type: Boolean, required: true },
    error: { type: String, default: null },
    calcularVolumePorSku: { type: Function, required: true },
  },
  emits: ['add-sku', 'edit-sku', 'delete-sku', 'adjust-stock', 'open-history', 'open-package-manager', 'open-kit-manager', 'connect-to-kit'],
  setup(props) {
    const query = ref('')
    const pkgFilter = ref('')
    const tbodyEl = ref(null)
    
    // Estado para controlar a expansão dos kits
    const expandedKits = ref([])

    const getPackageTypeClass = (name) => {
      if (name === 'Expedição Comum') return 'common'
      if (name === 'Expedição Premium') return 'premium'
      return 'default'
    }
    
    const getDeleteTooltip = (sku) => {
      if (sku.is_kit) {
        return 'Use a tela "Gerenciar Kits" para excluir'
      }
      if (sku.used_in_kits && sku.used_in_kits.length > 0) {
        const kitNames = sku.used_in_kits.map(k => k.kit_sku_code).join(', ')
        return `Este SKU é componente do(s) kit(s): ${kitNames}. Desconecte do kit primeiro.`
      }
      return sku.quantidade > 0 ? 'Zere o estoque antes de excluir' : 'Excluir SKU'
    }
    
    const getAdjustStockTooltip = (sku) => {
      if (sku.is_kit) {
        return 'Kits não possuem estoque físico'
      }
      if (sku.used_in_kits && sku.used_in_kits.length > 0) {
        const kitNames = sku.used_in_kits.map(k => k.kit_sku_code).join(', ')
        return `Este SKU é componente do(s) kit(s): ${kitNames}. O estoque é controlado através do kit.`
      }
      return 'Ajustar estoque'
    }
    
    const isSkuComponent = (sku) => {
      return sku.used_in_kits && sku.used_in_kits.length > 0
    }
    
    const canDeleteSku = (sku) => {
      if (sku.is_kit) return false
      if (isSkuComponent(sku)) return false
      return sku.quantidade === 0
    }
    
    const canAdjustStock = (sku) => {
      if (sku.is_kit) return false
      if (isSkuComponent(sku)) return false
      return true
    }
    
    // Função para alternar a expansão de um kit
    const toggleKitExpansion = (kitId) => {
      const index = expandedKits.value.indexOf(kitId)
      if (index > -1) {
        expandedKits.value.splice(index, 1)
      } else {
        expandedKits.value.push(kitId)
      }
    }

    // *** LÓGICA DE HIERARQUIA CORRIGIDA ***
    const hierarchyItems = computed(() => {
      // Validações para garantir que os props são arrays
      const allSkus = Array.isArray(props.skus) ? [...props.skus] : [];
      const kits = Array.isArray(props.activeKits) ? [...props.activeKits] : [];

      // Mapeia todos os SKUs por ID para busca rápida
      const skuMap = new Map(allSkus.map(s => [s.id, s]));
      
      // Guarda os IDs dos SKUs que são componentes de algum kit
      const childSkuIds = new Set();
      kits.forEach(kit => {
        (kit.kit_components || []).forEach(comp => childSkuIds.add(comp.child_sku_id));
      });

      const hierarchy = [];

      // 1. Adiciona os kits como itens "pai"
      kits.forEach(kit => {
        // Encontra os dados completos dos SKUs filhos (componentes)
        const children = (kit.kit_components || []).map(comp => {
          const childSku = skuMap.get(comp.child_sku_id);
          // Adiciona a quantidade por kit para exibição
          return childSku ? { ...childSku, quantity_per_kit: comp.quantity_per_kit } : null;
        }).filter(Boolean); // Remove nulos se algum filho não for encontrado

        hierarchy.push({
          ...kit,
          type: 'kit',
          children: children,
        });
      });

      // 2. Adiciona SKUs "órfãos" (que não são kits e nem componentes de kits)
      allSkus.forEach(sku => {
        if (!sku.is_kit && !childSkuIds.has(sku.id)) {
          hierarchy.push({
            ...sku,
            type: 'orphan',
          });
        }
      });
      
      // Ordena a lista final: kits primeiro, depois órfãos, todos em ordem alfabética
      return hierarchy.sort((a, b) => {
        if (a.type === 'kit' && b.type !== 'kit') return -1;
        if (a.type !== 'kit' && b.type === 'kit') return 1;
        return (a.sku || '').localeCompare(b.sku || '');
      });
    });
    
    const showKitDetails = (sku) => {
      if (!sku.kit_components || sku.kit_components.length === 0) {
        // Kit sem componentes - mostra mensagem informativa
        console.log('📦 Kit sem componentes:', sku.sku);
        // Aqui você pode implementar um toast ou notificação
        return;
      }
      
      // Kit com componentes - mostra detalhes
      console.log('📦 Detalhes do kit:', sku.sku, 'Componentes:', sku.kit_components);
      // Aqui você pode implementar um modal ou toast com detalhes dos componentes
    }

    const filteredSkus = computed(() => {
      let list = [...hierarchyItems.value];
      
      // Lógica de filtro por busca (query)
      if (query.value) {
        const q = query.value.toLowerCase();
        list = list.filter(item => {
          const mainMatch = (item.sku && item.sku.toLowerCase().includes(q)) || 
                            (item.descricao && item.descricao.toLowerCase().includes(q));
          
          if (item.type === 'kit') {
            const childMatch = (item.children || []).some(child => 
              (child.sku && child.sku.toLowerCase().includes(q)) ||
              (child.descricao && child.descricao.toLowerCase().includes(q))
            );
            return mainMatch || childMatch;
          }
          return mainMatch;
        });
      }
      
      // Lógica de filtro por tipo de pacote
      if (pkgFilter.value) {
        // ... (lógica de filtro de pacote)
      }
      
      return list;
    });

    const calcularVolumeTotalKit = (kit) => {
       if (!kit.children || kit.children.length === 0) return 0;
       return kit.children.reduce((total, child) => {
         const childVolume = props.calcularVolumePorSku(child);
         return total + (childVolume * (child.quantity_per_kit || 1));
       }, 0);
    };
    
    watch(filteredSkus, () => {
      if (props.isLoading || !tbodyEl.value) return;
      nextTick(() => {
        gsap.from(tbodyEl.value.children, {
          opacity: 0,
          y: 10,
          duration: 0.4,
          ease: 'power2.out',
          stagger: 0.05
        });
      });
    }, { immediate: true });

        return { 
      query, 
      pkgFilter, 
      filteredSkus, 
      tbodyEl, 
      expandedKits,
      toggleKitExpansion,
      getPackageTypeClass, 
      getDeleteTooltip, 
      getAdjustStockTooltip,
      isSkuComponent,
      canDeleteSku,
      canAdjustStock,
      showKitDetails, 
      calcularVolumeTotalKit 
    };
  }
})
</script>

<style scoped>
.wrap {
  background: #ffffff;
  border-radius: 12px;
  box-shadow: 0 1px 2px rgba(0, 0, 0, .06), 0 4px 12px rgba(0, 0, 0, .04);
}

.head {
  padding: 16px 16px 8px;
  border-bottom: 1px solid #e5e7eb;
  display: grid;
  gap: 12px;
}

.title { display: flex; align-items: center; gap: 10px; }
h2 { margin: 0; font-size: 1.125rem; font-weight: 700; color: #0f172a; }
.pill {
  padding: 2px 8px;
  border-radius: 999px;
  font-size: .75rem;
  color: #64748b;
  background: #f8fafc;
  border: 1px solid #e5e7eb;
}

.tools { display: flex; gap: 10px; flex-wrap: wrap; align-items: center; }
.search { position: relative; display: flex; align-items: center; }
.search svg { width: 18px; height: 18px; position: absolute; left: 10px; stroke: #64748b; }
.search input {
  padding: 10px 12px 10px 32px;
  border: 1px solid #e5e7eb;
  border-radius: 10px;
  background: #f8fafc;
  color: #0f172a;
  outline: none;
  min-width: 240px;
}
.search input:focus { border-color: #4f46e5; background: #ffffff; }

.select { padding: 10px 12px; border: 1px solid #e5e7eb; border-radius: 10px; background: #f8fafc; color: #0f172a; }

.actions { margin-left: auto; display: flex; gap: 8px; }
.btn { display: inline-flex; align-items: center; gap: 8px; border: none; cursor: pointer; border-radius: 10px; padding: 10px 14px; font-weight: 600; transition: transform .02s ease-in; }
.btn:active { transform: translateY(1px); }
.btn.primary { background: #4f46e5; color: #ffffff; }
.btn.primary:hover { background: #4338ca; }
.btn.ghost { background: #f8fafc; color: #0f172a; border: 1px solid #e5e7eb; }
.btn.ghost:hover { filter: brightness(0.98); }
.btn.ghost.kit-manager { background: #faf5ff; color: #7c3aed; border: 1px solid #e9d5ff; }
.btn.ghost.kit-manager:hover { background: #f3e8ff; color: #6d28d9; filter: none; }
.btn.ghost.kit-manager svg { color: #7c3aed; }

.table-container { overflow: auto; max-width: 100%; }
.sku-table th, .sku-table td { padding: 14px 16px; }

.sku-table { width: 100%; border-collapse: separate; border-spacing: 0; text-align: left; }
.sku-table thead th { position: sticky; top: 0; z-index: 1; background: #f8fafc; color: #64748b; text-transform: uppercase; letter-spacing: .04em; font-size: .72rem; border-bottom: 1px solid #e5e7eb; }
.sku-table tbody tr { border-bottom: 1px solid #e5e7eb; }
.sku-table tbody tr:hover { background: #f3f6ff; }
.th-actions { width: 120px; }
.ellipsis { max-width: 380px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.muted { color: #94a3b8; font-style: italic; }
.sku { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; border: 1px dashed #e5e7eb; padding: 2px 8px; border-radius: 999px; background: #ffffff; color: #0f172a; }
.qty { background: transparent; color: #4f46e5; border: 1px solid #c7d2fe; border-radius: 999px; padding: 2px 10px; font-weight: 700; cursor: pointer; }
.qty:hover { background: #eef2ff; }
.qty.kit-qty { color: #7c3aed; border-color: #ddd6fe; }
.qty.kit-qty:hover { background: #f5f3ff; }

.no-components {
  color: #6b7280;
  font-style: italic;
}

.no-quantity {
  text-align: center;
}

.kit-no-qty {
  color: #9ca3af;
  font-size: 1.2rem;
  font-weight: 300;
}

.badge { padding: 2px 8px; border-radius: 999px; font-size: .8rem; font-weight: 600; border: 1px solid #e5e7eb; }
.badge.premium { background: #ede9fe; color: #5b21b6; }
.badge.common { background: #f3f4f6; color: #111827; }

.quantity-cell { display: flex; flex-direction: column; align-items: flex-start; gap: 2px; }
.kit-stock-info { color: #6b7280; font-size: 0.7rem; }

.actions { display: flex; gap: 4px; }
.icon { background: transparent; border: none; padding: 6px; border-radius: 10px; cursor: pointer; color: #64748b; }
.icon:hover { background: #f8fafc; color: #0f172a; }
.icon.danger { color: #ef4444; }
.icon.kit-connect { color: #7c3aed; border: 1px solid #a78bfa; }
.icon.kit-connect:hover { background: #f3f4f6; border-color: #8b5cf6; color: #6d28d9; }
.icon.component-stock { color: #059669; border: 1px solid #6ee7b7; }
.icon.component-stock:hover { background: #f0fdf4; border-color: #34d399; color: #047857; }
.icon:disabled { opacity: .5; cursor: not-allowed; }
.icon.disabled-action { opacity: .4; cursor: not-allowed; color: #9ca3af !important; }
.icon.disabled-action:hover { background: transparent !important; color: #9ca3af !important; }

.alert.error { margin: 12px 16px; padding: 10px 12px; border: 1px solid #f7c6c6; border-radius: 10px; color: #b91c1c; background: #fff1f1; }
.empty { padding: 48px 16px; text-align: center; color: #94a3b8; display: grid; gap: 12px; justify-items: center; }
.empty .emoji { font-size: 2rem; }

.skeleton-wrapper { padding: 16px; }
.skeleton-row { display: flex; gap: 8px; margin-bottom: 12px; }
.sk.anim { height: 20px; border-radius: 8px; background: linear-gradient(90deg, #f0f2f5 25%, #e6e8eb 50%, #f0f2f5 75%); background-size: 200% 100%; animation: shimmer 1.5s ease-in-out infinite; }
@keyframes shimmer { 0% { background-position: 200% 0; } 100% { background-position: -200% 0; } }

svg { width: 18px; height: 18px; fill: none; stroke: currentColor; stroke-width: 2; stroke-linecap: round; stroke-linejoin: round; }

/* Estilos para a hierarquia visual */
.hierarchy-col { width: 250px; min-width: 250px; }
.kit-parent-item, .child-sku-item, .orphan-sku-item { display: flex; align-items: center; gap: 8px; position: relative; }
.hierarchy-icon { font-size: 1.2rem; flex-shrink: 0; }

/* Estilos para o botão de expansão */
.expand-toggle {
  background: transparent;
  border: none;
  padding: 4px;
  border-radius: 4px;
  cursor: pointer;
  color: #6b7280;
  transition: all 0.2s ease;
  display: flex;
  align-items: center;
  justify-content: center;
}

.expand-toggle:hover {
  background: #f3f4f6;
  color: #374151;
}

.expand-toggle.expanded svg {
  transform: rotate(90deg);
}

.expand-toggle svg {
  transition: transform 0.2s ease;
}

/* Contador de filhos */
.children-count {
  color: #6b7280;
  font-size: 0.8rem;
  font-style: italic;
}

.kit-parent-row { background: #faf5ff !important; border-left: 4px solid #7c3aed; }
.kit-parent-row:hover { background: #f3e8ff !important; }
.kit-parent-code { font-weight: 700; color: #6b21a8; background: #e9d5ff; border-color: #c4b5fd; }
.kit-status { padding: 2px 8px; border-radius: 999px; font-size: 0.75rem; font-weight: 600; }
.kit-status.active { background: #dcfce7; color: #166534; border: 1px solid #bbf7d0; }
.kit-status.inactive { background: #fee2e2; color: #991b1b; border: 1px solid #fecaca; }

.child-sku-row { background: #f8fafc !important; border-left: 4px solid #e2e8f0; position: relative; }
.child-sku-row:hover { background: #f1f5f9 !important; }
.child-sku-item { padding-left: 20px; }
.hierarchy-line { position: absolute; left: 10px; top: -14px; width: 1px; height: calc(50% + 14px); background: #cbd5e1; }
.hierarchy-line::before { content: ''; position: absolute; bottom: 0; left: 0; width: 10px; height: 1px; background: #cbd5e1; }
.child-icon { color: #64748b; font-size: 1rem; }
.child-code { color: #475569; background: #f1f5f9; border-color: #cbd5e1; }
.child-badge { background: #e0f2fe; color: #0369a1; padding: 2px 8px; border-radius: 999px; font-size: 0.75rem; font-weight: 600; border: 1px solid #bae6fd; }


.orphan-sku-row { background: #ffffff; }
.orphan-code { color: #374151; background: #f9fafb; border-color: #d1d5db; }
.orphan-badge { background: #f0f9ff; color: #0c4a6e; padding: 2px 8px; border-radius: 999px; font-size: 0.75rem; font-weight: 600; border: 1px solid #bfdbfe; }

@media (max-width: 760px) {
  .sku-table, .sku-table thead { display: none; }
  .table-container { padding: 8px; }
  tbody { display: grid; gap: 8px; }
  tbody tr { display: block; border: 1px solid #e5e7eb; border-radius: 12px; background: #ffffff; }
  tbody tr td { display: flex; justify-content: space-between; gap: 8px; padding: 8px 12px; border-bottom: 1px dashed #e5e7eb; }
  tbody tr td:last-child { border-bottom: none; }
  tbody tr td::before { content: attr(data-label); color: #94a3b8; }
  .th-actions, .actions { justify-content: flex-end; }
  .hierarchy-line { display: none; }
  .child-sku-item { padding-left: 0; }
}
</style>
