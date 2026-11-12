export default function Faq() {
  return (
    <section id="faq" className="faq-section">
      <div className="section-wrap">
        <div className="container-2nd">
          <div className="faq-grid">
            <div className="faq-contact-wrap">
              <div fade-anim="True" className="faq-contact-content-box">
                <div className="faq-contact-content-title">
                  Contact
                </div>
                <p className="faq-contact-content-text">
                  Give your agents exactly-once payments on Hedera
                </p>
              </div>
              <div fade-anim="True" className="faq-contact-button-box">
                <a data-wf--primary-button--variant="full-width" href="/login" className="primary-button w-variant-a463856d-9e90-63e6-cf33-267087a243a0 w-inline-block">
                  <div className="primary-button-text-items">
                    <div className="primary-button-text-wrap">
                      <div className="primary-button-text one">
                        CONTACT US
                      </div>
                      <div className="primary-button-text two">
                        CONTACT US
                      </div>
                    </div>
                  </div>
                  <div className="primary-button-icon-wrap">
                    <div className="primary-button-icon-box">
                      <img src="/assets/6a940bdd07117569c26e60b8_btn_icon.svg" loading="lazy" alt="Icon" className="primary-button-icon" />
                    </div>
                    <div className="primary-button-icon-box">
                      <img src="/assets/6a940df507117569c26eab94_btn_icon_2.svg" loading="lazy" alt="Icon" className="primary-button-icon" />
                    </div>
                    <div className="primary-button-icon-box two">
                      <img src="/assets/6a9d5d892f159f58a1b00821_btn_icon_3.svg" loading="lazy" alt="Icon" className="primary-button-icon" />
                    </div>
                    <div className="primary-button-icon-box two">
                      <img src="/assets/6a9d5d88f0c4f20f0444af57_btn_icon_4.svg" loading="lazy" alt="Icon" className="primary-button-icon" />
                    </div>
                  </div>
                </a>
              </div>
              <div scale-up="True" className="faq-contact-shape-box">
                <img src="/assets/6a955b8976725cc3eecbec3b_6b3957fdaa5fd0eb791a890a25c81581_feature_banner.avif" loading="lazy" sizes="100vw" srcSet="/assets/6a955b8976725cc3eecbec3b_6b3957fdaa5fd0eb791a890a25c81581_feature_banner_p_500.avif 500w, /assets/6a955b8976725cc3eecbec3b_6b3957fdaa5fd0eb791a890a25c81581_feature_banner_p_800.avif 800w, /assets/6a955b8976725cc3eecbec3b_6b3957fdaa5fd0eb791a890a25c81581_feature_banner_p_1080.avif 1080w, /assets/6a955b8976725cc3eecbec3b_6b3957fdaa5fd0eb791a890a25c81581_feature_banner.avif 1522w" alt="Shape" className="faq-contact-shape" />
              </div>
            </div>
            <div id="w-node-decca4e6-faef-834f-aa29-bc3994c5a4ba-74527ddb" className="faq-content-flex">
              <div fade-anim="True" className="faq-content-title-box">
                <h2 className="hero-banner-title color">
                  {"Frequently Asked "}
                </h2>
                <div className="hero-banner-title bg">
                  {" Questions"}
                </div>
              </div>
              <div fade-anim="True" className="faq-wrap">
                <div className="faq-items">
                  <div className="faq-title-flex">
                    <div className="faq-qus">
                      What if the connection drops mid-payment?
                    </div>
                    <div className="faq-qus-icon-wrap">
                      <div className="faq-qus-icon-box">
                        <img src="/assets/6a9ea080776b7896e4020230_angle_down.svg" loading="lazy" alt="Arrow" className="faq-qus-icon" />
                      </div>
                    </div>
                  </div>
                  <div className="faq-ans-box">
                    <p className="faq-ans-text">
                      The resolver asks Mirror Node by transaction id. Found means PAID. Not found after the 120 s death clock plus a 45 s margin means VOID forever, and the next round opens.
                    </p>
                  </div>
                </div>
                <div className="faq-items">
                  <div className="faq-title-flex">
                    <div className="faq-qus">
                      What if two of my agents buy the same thing?
                    </div>
                    <div className="faq-qus-icon-wrap">
                      <div className="faq-qus-icon-box">
                        <img src="/assets/6a9ea080776b7896e4020230_angle_down.svg" loading="lazy" alt="Arrow" className="faq-qus-icon" />
                      </div>
                    </div>
                  </div>
                  <div className="faq-ans-box">
                    <p className="faq-ans-text">
                      Both post a claim. Hedera Consensus Service orders them, the first valid claim wins and the other backs off. One job, one payment, even across Claude, Cursor and scripts.
                    </p>
                  </div>
                </div>
                <div className="faq-items">
                  <div className="faq-title-flex">
                    <div className="faq-qus">
                      Do my agents hold payment keys?
                    </div>
                    <div className="faq-qus-icon-wrap">
                      <div className="faq-qus-icon-box">
                        <img src="/assets/6a9ea080776b7896e4020230_angle_down.svg" loading="lazy" alt="Arrow" className="faq-qus-icon" />
                      </div>
                    </div>
                  </div>
                  <div className="faq-ans-box">
                    <p className="faq-ans-text">
                      No. Agents hold only an identity key. The Klero payer signs for the HCS winner, within the per-payment cap, daily cap and allowlist you set.
                    </p>
                  </div>
                </div>
                <div className="faq-items">
                  <div className="faq-title-flex">
                    <div className="faq-qus">
                      Why World ID?
                    </div>
                    <div className="faq-qus-icon-wrap">
                      <div className="faq-qus-icon-box">
                        <img src="/assets/6a9ea080776b7896e4020230_angle_down.svg" loading="lazy" alt="Arrow" className="faq-qus-icon" />
                      </div>
                    </div>
                  </div>
                  <div className="faq-ans-box">
                    <p className="faq-ans-text">
                      Each agent links to its human once with World ID Agent Pass. Firing an agent or spending above the autonomous cap needs a fresh approval bound to that exact action.
                    </p>
                  </div>
                </div>
                <div className="faq-items">
                  <div className="faq-title-flex">
                    <div className="faq-qus">
                      Can I verify it myself?
                    </div>
                    <div className="faq-qus-icon-wrap">
                      <div className="faq-qus-icon-box">
                        <img src="/assets/6a9ea080776b7896e4020230_angle_down.svg" loading="lazy" alt="Arrow" className="faq-qus-icon" />
                      </div>
                    </div>
                  </div>
                  <div className="faq-ans-box">
                    <p className="faq-ans-text">
                      Yes. Every event is written to a public HCS topic. Run npx klero audit to rebuild and check the whole history from Mirror Node, without trusting our server.
                    </p>
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
