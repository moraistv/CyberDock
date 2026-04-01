# Design Document

## Overview

Este documento detalha o design para adicionar duas novas colunas nas tabelas de vendas do sistema CyberDock: "Cliente" (nome do comprador) e "ID da Venda" (identificador único da venda). As modificações serão aplicadas tanto na tabela master (`MasterSalesTable.vue`) quanto na tabela de usuário (`UserSalesTable.vue`), mantendo a consistência visual e funcional do sistema.

## Architecture

### Componentes Afetados

1. **UserSalesTable.vue** - Tabela principal de vendas para usuários
2. **MasterSalesTable.vue** - Tabela de vendas para usuários master/administradores
3. **TabelaVendas.vue** - Possível componente adicional de vendas (se existir)

### Fonte de Dados

Os dados para as novas colunas serão extraídos da estrutura existente:

- **ID da Venda**: Campo `sale.id` já disponível nos dados
- **Nome do Cliente**: Extraído de `sale.raw_api_data.buyer` ou campos relacionados na API do Mercado Livre

## Components and Interfaces

### 1. Estrutura de Dados

```javascript
// Estrutura esperada dos dados de venda
{
  id: number,                    // ID da venda (já existe)
  sku: string,
  raw_api_data: {
    buyer: {
      id: number,
      nickname: string,          // Nome/nickname do comprador
      first_name: string,        // Primeiro nome
      last_name: string          // Sobrenome
    },
    // outros campos...
  }
  // outros campos existentes...
}
```

### 2. Funções Utilitárias

```javascript
// Função para extrair nome do cliente
function getCustomerName(sale) {
  const buyer = sale?.raw_api_data?.buyer;
  if (!buyer) return 'N/A';
  
  // Prioridade: nome completo > nickname > ID
  if (buyer.first_name && buyer.last_name) {
    return `${buyer.first_name} ${buyer.last_name}`;
  }
  if (buyer.nickname) {
    return buyer.nickname;
  }
  return `Cliente #${buyer.id}`;
}

// Função para copiar ID da venda
function copySaleId(saleId) {
  if (navigator.clipboard) {
    navigator.clipboard.writeText(saleId.toString());
    // Mostrar feedback visual
  }
}
```

### 3. Modificações na Tabela

#### UserSalesTable.vue
- Adicionar duas novas colunas no `<thead>`
- Adicionar células correspondentes no `<tbody>`
- Manter responsividade com `data-label` para mobile

#### MasterSalesTable.vue
- Implementar as mesmas colunas com layout consistente
- Considerar espaço adicional na tabela master

## Data Models

### Estrutura de Dados Expandida

```typescript
interface Sale {
  id: number;
  sku: string;
  uid: string;
  seller_id: number;
  channel: string;
  account_nickname: string;
  sale_date: string;
  product_title: string;
  quantity: number;
  shipping_mode: string;
  shipping_limit_date: string;
  packages: number;
  shipping_status: string;
  raw_api_data: {
    buyer?: {
      id: number;
      nickname?: string;
      first_name?: string;
      last_name?: string;
    };
    // outros campos da API do ML
  };
  updated_at: string;
  processed_at: string;
  
  // Campos computados (não persistidos)
  customer_name?: string;  // Calculado via getCustomerName()
}
```

## Error Handling

### Cenários de Erro

1. **Dados do Cliente Indisponíveis**
   - Exibir "N/A" quando `raw_api_data.buyer` não existir
   - Fallback para ID do comprador se disponível

2. **ID da Venda Inválido**
   - Validar se `sale.id` é um número válido
   - Exibir "N/A" para IDs inválidos

3. **Falha na Cópia do ID**
   - Implementar fallback para navegadores sem suporte a Clipboard API
   - Mostrar mensagem de erro amigável

### Implementação de Tratamento de Erros

```javascript
// Tratamento robusto para nome do cliente
function getCustomerName(sale) {
  try {
    const buyer = sale?.raw_api_data?.buyer;
    if (!buyer) return 'N/A';
    
    if (buyer.first_name && buyer.last_name) {
      return `${buyer.first_name} ${buyer.last_name}`.trim();
    }
    if (buyer.nickname) {
      return buyer.nickname.trim();
    }
    if (buyer.id) {
      return `Cliente #${buyer.id}`;
    }
    return 'N/A';
  } catch (error) {
    console.warn('Erro ao extrair nome do cliente:', error);
    return 'N/A';
  }
}

// Tratamento para cópia do ID
async function copySaleId(saleId) {
  try {
    if (!saleId) {
      throw new Error('ID da venda não disponível');
    }
    
    if (navigator.clipboard && navigator.clipboard.writeText) {
      await navigator.clipboard.writeText(saleId.toString());
      // Mostrar toast de sucesso
      showToast('ID copiado para a área de transferência', 'success');
    } else {
      // Fallback para navegadores antigos
      const textArea = document.createElement('textarea');
      textArea.value = saleId.toString();
      document.body.appendChild(textArea);
      textArea.select();
      document.execCommand('copy');
      document.body.removeChild(textArea);
      showToast('ID copiado para a área de transferência', 'success');
    }
  } catch (error) {
    console.error('Erro ao copiar ID:', error);
    showToast('Erro ao copiar ID da venda', 'error');
  }
}
```

## Testing Strategy

### 1. Testes Unitários

```javascript
// Testes para getCustomerName()
describe('getCustomerName', () => {
  test('deve retornar nome completo quando disponível', () => {
    const sale = {
      raw_api_data: {
        buyer: {
          first_name: 'João',
          last_name: 'Silva'
        }
      }
    };
    expect(getCustomerName(sale)).toBe('João Silva');
  });

  test('deve retornar nickname quando nome completo não disponível', () => {
    const sale = {
      raw_api_data: {
        buyer: {
          nickname: 'joaosilva123'
        }
      }
    };
    expect(getCustomerName(sale)).toBe('joaosilva123');
  });

  test('deve retornar N/A quando dados do comprador não disponíveis', () => {
    const sale = { raw_api_data: {} };
    expect(getCustomerName(sale)).toBe('N/A');
  });
});
```

### 2. Testes de Integração

- Verificar se as colunas são renderizadas corretamente
- Testar responsividade em diferentes tamanhos de tela
- Validar funcionamento da cópia do ID da venda
- Testar com dados reais da API do Mercado Livre

### 3. Testes de Regressão

- Garantir que funcionalidades existentes não foram quebradas
- Verificar performance com grandes volumes de dados
- Testar filtros e ordenação incluindo as novas colunas

## Implementation Notes

### Considerações de Performance

1. **Cálculo do Nome do Cliente**
   - Implementar como computed property para cache automático
   - Evitar recálculos desnecessários durante re-renders

2. **Responsividade da Tabela**
   - Considerar scroll horizontal para telas pequenas
   - Implementar priorização de colunas em mobile

### Acessibilidade

1. **Labels Apropriados**
   - Adicionar `aria-label` para botão de copiar ID
   - Usar `title` attributes para tooltips informativos

2. **Navegação por Teclado**
   - Garantir que botão de copiar seja acessível via Tab
   - Implementar atalhos de teclado se necessário

### Compatibilidade

- Suporte para navegadores modernos (Chrome 60+, Firefox 55+, Safari 12+)
- Fallback para Clipboard API em navegadores antigos
- Testes em diferentes resoluções de tela