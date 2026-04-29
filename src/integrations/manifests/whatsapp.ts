import type { IntegrationManifest } from '../../types/integrations';

export const whatsappManifest: IntegrationManifest = {
  id: 'whatsapp',
  nameKey: 'integrations.whatsapp.name',
  descriptionKey: 'integrations.whatsapp.description',
  iconKey: 'whatsapp',
  authMode: 'qr_pairing',
  fields: [],
  setupStepKeys: [
    'integrations.whatsapp.steps.openWhatsApp',
    'integrations.whatsapp.steps.linkedDevices',
    'integrations.whatsapp.steps.scanQr',
  ],
  docsUrl: 'https://faq.whatsapp.com/378279804439436',
  customModalId: 'whatsapp',
  ipc: {
    status: async () => {
      const r = await window.cerebro.whatsapp.status();
      return {
        connected: r.state === 'connected',
        details: r.phoneNumber
          ? { phoneNumber: r.phoneNumber, pushName: r.pushName }
          : { state: r.state },
      };
    },
  },
};
