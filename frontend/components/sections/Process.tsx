export default function Process() {
  return (
    <section id="how-it-works" className="process-section">
      <div className="section-wrap">
        <div className="container top-border">
          <div className="extra-height" />
        </div>
      </div>
      <div data-wf--section-wrap--variant="main-mood" className="section-wrap">
        <div className="container title-container top-border">
          <div className="section-title-flex">
            <h2 className="section-title">
              HOW IT WORKS
            </h2>
            <div className="section-title section-number">
              007
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
        <div className="container border-vertical padding-zero">
          <div className="process-title-flex">
            <div scale-up="True" className="process-title-box">
              <div className="process-title">
                FOUR STEPS FROM FORK TO RECEIPT
              </div>
            </div>
            <div scale-up="True" className="process-button-box">
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
          <div data-current="Tab 1" data-easing="ease" data-duration-in="300" data-duration-out="100" className="process-tabs w-tabs">
            <div className="process-tabs-menu w-tab-menu">
              <a data-w-tab="Tab 1" className="process-tabs-link border-none w-inline-block w-tab-link w--current">
                <div className="process-tabs-link-text">
                  Claim
                </div>
                <div className="process-tabs-link-text">
                  01
                </div>
              </a>
              <a data-w-tab="Tab 2" className="process-tabs-link border-none w-inline-block w-tab-link">
                <div className="process-tabs-link-text">
                  Referee
                </div>
                <div className="process-tabs-link-text">
                  02
                </div>
              </a>
              <a data-w-tab="Tab 3" className="process-tabs-link w-inline-block w-tab-link">
                <div className="process-tabs-link-text">
                  Intent
                </div>
                <div className="process-tabs-link-text">
                  03
                </div>
              </a>
              <a data-w-tab="Tab 4" className="process-tabs-link last w-inline-block w-tab-link">
                <div className="process-tabs-link-text">
                  Settle
                </div>
                <div className="process-tabs-link-text">
                  04
                </div>
              </a>
            </div>
            <div className="process-tabs-content w-tab-content">
              <div data-w-tab="Tab 1" className="process-tabs-items w-tab-pane w--tab-active">
                <div className="process-tabs-grid">
                  <div className="process-tabs-contents-wrap">
                    <div fade-anim="True" className="process-tabs-contents-flex">
                      <div className="process-tabs-title">
                        Claim
                      </div>
                      <div className="process-tabs-contents-box">
                        <div className="process-tabs-contents-tags-flex">
                          <div className="process-tabs-contents-tags">
                            Job key
                          </div>
                          <div className="process-tabs-contents-tags">
                            HCS
                          </div>
                        </div>
                        <p className="process-contents-description">
                          Every agent computes the same job key from your human id, the capability and the input hash, then posts a claim on the HCS topic, paid by its own Hedera account.
                        </p>
                      </div>
                    </div>
                  </div>
                  <div className="process-tabs-banner-items">
                    <div className="process-tabs-banner-box">
                      <img src="/assets/6a95747fd259065c44156f86_s2.svg" loading="lazy" alt="Process Tabs Banner" className="process-tabs-banner" />
                    </div>
                  </div>
                </div>
              </div>
              <div data-w-tab="Tab 2" className="process-tabs-items w-tab-pane">
                <div className="process-tabs-grid">
                  <div className="process-tabs-contents-wrap">
                    <div className="process-tabs-contents-flex">
                      <div className="process-tabs-title">
                        Referee
                      </div>
                      <div className="process-tabs-contents-box">
                        <div className="process-tabs-contents-tags-flex">
                          <div className="process-tabs-contents-tags">
                            Consensus
                          </div>
                          <div className="process-tabs-contents-tags">
                            Mirror Node
                          </div>
                        </div>
                        <p className="process-contents-description">
                          Hedera Consensus Service orders the claims. The first valid claim for the round wins and every agent reads the same winner from Mirror Node. The others back off.
                        </p>
                      </div>
                    </div>
                  </div>
                  <div className="process-tabs-banner-items">
                    <div className="process-tabs-banner-box">
                      <img src="/assets/6a95747f4fb0f6996642b6c5_s.svg" loading="lazy" alt="Process Tabs Banner" className="process-tabs-banner" />
                    </div>
                  </div>
                </div>
              </div>
              <div data-w-tab="Tab 3" className="process-tabs-items w-tab-pane">
                <div className="process-tabs-grid">
                  <div className="process-tabs-contents-wrap">
                    <div className="process-tabs-contents-flex">
                      <div className="process-tabs-title">
                        Intent
                      </div>
                      <div className="process-tabs-contents-box">
                        <div className="process-tabs-contents-tags-flex">
                          <div className="process-tabs-contents-tags">
                            120 s
                          </div>
                          <div className="process-tabs-contents-tags">
                            Stored first
                          </div>
                        </div>
                        <p className="process-contents-description">
                          Klero builds the winner's payment as an intent: a Hedera transfer with a known transaction id that dies 120 seconds after its valid start. It is stored before it is sent.
                        </p>
                      </div>
                    </div>
                  </div>
                  <div className="process-tabs-banner-items">
                    <div className="process-tabs-banner-box">
                      <img src="/assets/klero-safeguards.svg" loading="lazy" alt="Process Tabs Banner" className="process-tabs-banner" />
                    </div>
                  </div>
                </div>
              </div>
              <div data-w-tab="Tab 4" className="process-tabs-items w-tab-pane">
                <div className="process-tabs-grid">
                  <div className="process-tabs-contents-wrap">
                    <div className="process-tabs-contents-flex">
                      <div className="process-tabs-title">
                        Settle
                      </div>
                      <div className="process-tabs-contents-box">
                        <div className="process-tabs-contents-tags-flex">
                          <div className="process-tabs-contents-tags">
                            x402
                          </div>
                          <div className="process-tabs-contents-tags">
                            HTS
                          </div>
                        </div>
                        <p className="process-contents-description">
                          The provider checks HCS, settles through our x402 facilitator in FUSD, then runs the job. If the job fails it refunds in HTS. Unknown outcomes resolve to PAID or VOID.
                        </p>
                      </div>
                    </div>
                  </div>
                  <div className="process-tabs-banner-items">
                    <div className="process-tabs-banner-box">
                      <img src="/assets/6a991bbf39bdd2820cca6452_m_20_1_.avif" loading="lazy" sizes="100vw" srcSet="/assets/6a991bbf39bdd2820cca6452_m_20_1__p_500.avif 500w, /assets/6a991bbf39bdd2820cca6452_m_20_1_.avif 584w" alt="Process Tabs Banner" className="process-tabs-banner" />
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
