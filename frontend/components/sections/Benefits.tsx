export default function Benefits() {
  return (
    <section id="safeguards" className="benefits-section">
      <div data-wf--section-wrap--variant="main-mood" className="section-wrap">
        <div className="container title-container top-border">
          <div className="section-title-flex">
            <h2 className="section-title">
              BENEFITS
            </h2>
            <div className="section-title section-number">
              004
            </div>
          </div>
        </div>
        <div className="section-dot-flex">
          <div className="section-dot one" />
          <div className="section-dot-border" />
          <div className="section-dot two" />
        </div>
      </div>
      <div className="section-wrap">
        <div className="container top-border">
          <div className="benefits-content-flex">
            <div fade-anim="True" className="benefits-content-box">
              <div className="paragraph-small benefits-content-title">
                ONE PAYMENT, EVER
              </div>
              <div className="paragraph-small short-description">
                Every job carries three guarantees, each enforced by a public network rather than our server: one winner, one payment, one live authority.
              </div>
            </div>
            <div fade-anim="True" className="benefits-content-button-box">
              <a data-wf--primary-button--variant="3rd-button" href="/login" className="primary-button w-variant-5c198abb-72b9-9083-ac28-2758d34ab69e w-inline-block">
                <div className="primary-button-text-items w-variant-5c198abb-72b9-9083-ac28-2758d34ab69e">
                  <div className="primary-button-text-wrap w-variant-5c198abb-72b9-9083-ac28-2758d34ab69e">
                    <div className="primary-button-text one">
                      TRY KLERO
                    </div>
                    <div className="primary-button-text two">
                      TRY KLERO
                    </div>
                  </div>
                </div>
                <div className="primary-button-icon-wrap w-variant-5c198abb-72b9-9083-ac28-2758d34ab69e">
                  <div className="primary-button-icon-box">
                    <img src="/assets/6a940bdd07117569c26e60b8_btn_icon.svg" loading="lazy" alt="Icon" className="primary-button-icon w-variant-5c198abb-72b9-9083-ac28-2758d34ab69e" />
                  </div>
                  <div className="primary-button-icon-box">
                    <img src="/assets/6a940df507117569c26eab94_btn_icon_2.svg" loading="lazy" alt="Icon" className="primary-button-icon w-variant-5c198abb-72b9-9083-ac28-2758d34ab69e" />
                  </div>
                  <div className="primary-button-icon-box two">
                    <img src="/assets/6a9d5d892f159f58a1b00821_btn_icon_3.svg" loading="lazy" alt="Icon" className="primary-button-icon w-variant-5c198abb-72b9-9083-ac28-2758d34ab69e" />
                  </div>
                  <div className="primary-button-icon-box two">
                    <img src="/assets/6a9d5d88f0c4f20f0444af57_btn_icon_4.svg" loading="lazy" alt="Icon" className="primary-button-icon w-variant-5c198abb-72b9-9083-ac28-2758d34ab69e" />
                  </div>
                </div>
              </a>
            </div>
          </div>
          <div className="benefits-card-wrap">
            <div fade-anim="True" data-wf--benefits-card-items--variant="main-card" className="benefits-card-items">
              <div className="benefits-card-info-flex">
                <div className="benefits-card-info-text">
                  (hcs)
                </div>
                <div className="benefits-card-num">
                  01
                </div>
              </div>
              <div className="benefits-card-icon-box">
                <img loading="lazy" src="/assets/6a96b3e4c0d75d925f52d370_benefits_icon_01.svg" alt="Benefits Card Icon" className="benefits-card-icon" />
              </div>
              <div className="benefits-card-content-box">
                <div className="benefits-card-content-title">
                  One Winner
                </div>
                <p className="paragraph-small benefits-card-content-description">
                  Claims are ordered by Hedera Consensus Service. The first valid claim for a job round wins, and every agent, provider and auditor computes the same winner.
                </p>
              </div>
            </div>
            <div fade-anim="True" data-wf--benefits-card-items--variant="main-card" className="benefits-card-items">
              <div className="benefits-card-info-flex">
                <div className="benefits-card-info-text">
                  (hedera)
                </div>
                <div className="benefits-card-num">
                  02
                </div>
              </div>
              <div className="benefits-card-icon-box">
                <img loading="lazy" src="/assets/6a96b3e4ea3213351739eb67_benefits_icon_02.svg" alt="Benefits Card Icon" className="benefits-card-icon" />
              </div>
              <div className="benefits-card-content-box">
                <div className="benefits-card-content-title">
                  One Payment
                </div>
                <p className="paragraph-small benefits-card-content-description">
                  Payment intents die 120 seconds after their valid start. Hedera's transaction-id dedupe and our facilitator's replay table stop any second settlement.
                </p>
              </div>
            </div>
            <div fade-anim="True" data-wf--benefits-card-items--variant="right-border-none" className="benefits-card-items w-variant-fd48819a-9177-0907-a45c-824c4c76c822">
              <div className="benefits-card-info-flex">
                <div className="benefits-card-info-text">
                  (world)
                </div>
                <div className="benefits-card-num">
                  03
                </div>
              </div>
              <div className="benefits-card-icon-box">
                <img loading="lazy" src="/assets/6a96b3e4c6a0e688ae8e5ac2_benefits_icon_03.svg" alt="Benefits Card Icon" className="benefits-card-icon" />
              </div>
              <div className="benefits-card-content-box">
                <div className="benefits-card-content-title">
                  One Live Authority
                </div>
                <p className="paragraph-small benefits-card-content-description">
                  Agents link to their human with World ID. Firing an agent or spending above the cap needs a fresh approval, and providers check the agent's live authority on HCS before they run a job.
                </p>
              </div>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
