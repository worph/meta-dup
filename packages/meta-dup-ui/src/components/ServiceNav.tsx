import { useState, useEffect } from 'react';

interface ServiceInfo {
  name: string;
  hostname: string;
  baseUrl: string;
  status: string;
  lastHeartbeat: string;
}

interface ServicesResponse {
  services: ServiceInfo[];
  current: string;
}

const serviceIcons: Record<string, string> = {
  'meta-sort': '📁',
  'meta-fuse': '🗂️',
  'meta-stremio': '🎬',
  'meta-core': '⚙️',
  'meta-dup': '🔍',
  'meta-orbit': '🌐',
  'default': '📦'
};

function formatServiceName(name: string): string {
  return name.split('-').map(word =>
    word.charAt(0).toUpperCase() + word.slice(1)
  ).join(' ');
}

function ServiceNav() {
  const [services, setServices] = useState<ServiceInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const currentService = 'meta-dup';

  useEffect(() => {
    const fetchServices = async () => {
      try {
        const response = await fetch('/api/services');
        if (response.ok) {
          const data: ServicesResponse = await response.json();
          setServices(data.services || []);
        }
      } catch (error) {
        console.error('Failed to fetch services:', error);
      } finally {
        setLoading(false);
      }
    };

    fetchServices();
    const interval = setInterval(fetchServices, 30000);
    return () => clearInterval(interval);
  }, []);

  if (loading) return null;

  const sortedServices = [...services].sort((a, b) => a.name.localeCompare(b.name));

  if (sortedServices.length === 0) return null;

  return (
    <nav className="services-nav">
      <span className="services-nav-label">Services:</span>
      <div className="services-nav-items">
        {sortedServices.map(service => {
          const icon = serviceIcons[service.name] || serviceIcons.default;
          const isActive = service.name === currentService;
          return (
            <a
              key={service.name}
              href={isActive ? '#' : service.baseUrl}
              className={`service-link${isActive ? ' active' : ''}`}
              onClick={(e) => {
                e.preventDefault();
                if (!isActive) {
                  window.location.href = service.baseUrl;
                }
              }}
            >
              <span className="service-icon">{icon}</span>
              <span>{formatServiceName(service.name)}</span>
              <span className="service-status"></span>
            </a>
          );
        })}
      </div>

      <style>{`
        .services-nav {
          background: var(--bg-secondary);
          border-radius: 12px;
          padding: 0.5rem;
          margin-bottom: 1.5rem;
          display: flex;
          align-items: center;
          gap: 0.5rem;
          flex-wrap: wrap;
          border: 1px solid var(--border-color);
        }

        .services-nav-label {
          color: var(--text-secondary);
          font-size: 0.85rem;
          padding: 0.5rem 0.75rem;
          white-space: nowrap;
        }

        .services-nav-items {
          display: flex;
          gap: 0.5rem;
          flex-wrap: wrap;
        }

        .service-link {
          display: inline-flex;
          align-items: center;
          gap: 0.4rem;
          padding: 0.5rem 1rem;
          border-radius: 8px;
          text-decoration: none;
          font-size: 0.9rem;
          font-weight: 500;
          transition: all 0.2s;
          color: var(--text-primary);
          background: var(--bg-tertiary);
          border: 1px solid var(--border-color);
        }

        .service-link:hover {
          background: var(--border-color);
          border-color: rgba(78, 205, 196, 0.5);
          text-decoration: none;
        }

        .service-link.active {
          background: linear-gradient(135deg, rgba(78, 205, 196, 0.2), rgba(68, 160, 141, 0.2));
          border-color: rgba(78, 205, 196, 0.5);
        }

        .service-link .service-icon {
          font-size: 1.1rem;
        }

        .service-link .service-status {
          width: 6px;
          height: 6px;
          border-radius: 50%;
          background: var(--accent-primary);
          margin-left: 0.25rem;
        }

        @media (max-width: 600px) {
          .services-nav {
            flex-direction: column;
            align-items: flex-start;
          }
        }
      `}</style>
    </nav>
  );
}

export default ServiceNav;
