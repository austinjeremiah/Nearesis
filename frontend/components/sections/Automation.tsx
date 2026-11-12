export default function Automation() {
  return (
    <section className="automation-section">
      <div className="section-wrap">
        <div className="container color top-border">
          <div className="extra-height" />
        </div>
      </div>
      <div data-wf--section-wrap--variant="second-mood" className="section-wrap">
        <div className="container title-container w-variant-0d7a3a05-4c6a-cab0-9e2f-7c9727c2b618 top-border">
          <div className="section-title-flex w-variant-0d7a3a05-4c6a-cab0-9e2f-7c9727c2b618">
            <h2 className="section-title w-variant-0d7a3a05-4c6a-cab0-9e2f-7c9727c2b618">
              WHY HEDERA
            </h2>
            <div className="section-title w-variant-0d7a3a05-4c6a-cab0-9e2f-7c9727c2b618 section-number">
              010
            </div>
          </div>
        </div>
        <div className="section-dot-flex">
          <div className="section-dot w-variant-0d7a3a05-4c6a-cab0-9e2f-7c9727c2b618 one" />
          <div className="section-dot-border w-variant-0d7a3a05-4c6a-cab0-9e2f-7c9727c2b618" />
          <div className="section-dot w-variant-0d7a3a05-4c6a-cab0-9e2f-7c9727c2b618 two" />
        </div>
      </div>
      <div className="section-wrap">
        <div className="container-2nd extra-padding">
          <div className="automation-flex">
            <div className="automation-content-flex">
              <div fade-anim="True" className="automation-content-box">
                <div className="automation-content-text">
                  Hedera makes an unknown payment provable: either it settled, or it can never settle
                </div>
              </div>
              <div fade-anim="True" className="automation-card-content-flex">
                <div className="automation-card-content-text">
                  (I) Deterministic expiry
                </div>
                <div className="automation-card-content-border" />
                <p className="automation-card-content-description">
                  The network rejects a transaction past its valid start plus 120 seconds and any id it has already seen, so a Mirror Node 404 after the clock is proof, not a guess.
                </p>
              </div>
            </div>
            <div fade-anim="True" className="automation-content-button-box">
              <a data-wf--primary-button--variant="4th-button" href="/login" className="primary-button w-variant-c8937a21-aef7-f716-ecab-1c4a85c94367 w-inline-block">
                <div className="primary-button-text-items w-variant-c8937a21-aef7-f716-ecab-1c4a85c94367">
                  <div className="primary-button-text-wrap">
                    <div className="primary-button-text one">
                      TRY KLERO
                    </div>
                    <div className="primary-button-text two">
                      TRY KLERO
                    </div>
                  </div>
                </div>
                <div className="primary-button-icon-wrap w-variant-c8937a21-aef7-f716-ecab-1c4a85c94367">
                  <div className="primary-button-icon-box w-variant-c8937a21-aef7-f716-ecab-1c4a85c94367">
                    <img src="/assets/6a940bdd07117569c26e60b8_btn_icon.svg" loading="lazy" alt="Icon" className="primary-button-icon" />
                  </div>
                  <div className="primary-button-icon-box w-variant-c8937a21-aef7-f716-ecab-1c4a85c94367">
                    <img src="/assets/6a940df507117569c26eab94_btn_icon_2.svg" loading="lazy" alt="Icon" className="primary-button-icon" />
                  </div>
                  <div className="primary-button-icon-box w-variant-c8937a21-aef7-f716-ecab-1c4a85c94367 two">
                    <img src="/assets/6a9d5d892f159f58a1b00821_btn_icon_3.svg" loading="lazy" alt="Icon" className="primary-button-icon" />
                  </div>
                  <div className="primary-button-icon-box w-variant-c8937a21-aef7-f716-ecab-1c4a85c94367 two">
                    <img src="/assets/6a9d5d88f0c4f20f0444af57_btn_icon_4.svg" loading="lazy" alt="Icon" className="primary-button-icon" />
                  </div>
                </div>
              </a>
            </div>
          </div>
        </div>
      </div>
      <div className="section-wrap automation-apps-wrap">
        <div className="container-2nd">
          <div className="automation-apps-bg-box">
            <div fade-anim="True" className="automation-apps-logo-wrap">
              <div className="automation-apps-logo-box">
                <img src="/assets/klero-site-logo.svg" loading="lazy" alt="Logo" className="automation-apps-logo" />
              </div>
              <div className="automation-apps-logo-box">
                <img src="/assets/klero-web-badge.svg" loading="lazy" alt="Open the Klero web app" className="automation-apps-logo" />
              </div>
            </div>
            <div className="automation-apps-flex">
              <div fade-anim="True" className="automation-apps-banner-box">
                <img src="/assets/klero-web-app.svg" loading="lazy" alt="Klero web app race dashboard" className="automation-apps-banner" />
              </div>
              <div className="automation-apps-shape-flex">
                <div className="automation-apps-shape-wrap">
                  <div scale-up="True" className="automation-apps-shape-box one">
                    <img src="/assets/klero-race-card.svg" loading="lazy" alt="Automation Apps Shape" className="automation-apps-shape" />
                  </div>
                  <div scale-up="True" className="automation-apps-shape-box two">
                    <img src="/assets/6abe02fede5f2f15b10a8115_agent_card.svg" loading="lazy" alt="Automation Apps Shape" className="automation-apps-shape" />
                  </div>
                </div>
                <div fade-anim="True" className="automation-apps-content-box">
                  <p className="automation-apps-content-text">
                    Klero ships as an MCP server, an agent kit and a CLI. Give any MCP agent a safe pay tool, and let anyone rebuild the whole history from Mirror Node with npx klero audit.
                  </p>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
