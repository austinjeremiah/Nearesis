export default function Blogs() {
  return (
    <section className="home-blogs-section">
      <div className="section-wrap">
        <div className="container top-border">
          <div className="extra-height" />
        </div>
      </div>
      <div data-wf--section-wrap--variant="main-mood" className="section-wrap">
        <div className="container title-container top-border">
          <div className="section-title-flex">
            <h2 className="section-title">
              DOCS
            </h2>
            <div className="section-title section-number">
              008
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
        <div className="container padding-zero top-border">
          <div className="home-blogs-flex">
            <div fade-anim="True" className="home-blogs-section-title-wrap">
              <div className="home-blogs-section-title">
                Real networks, public proof.
              </div>
              <div className="home-blogs-section-icon-box">
                <img src="/assets/6a9c01468728423935f18cd1_blogs_arrow.svg" loading="lazy" alt="Arrow" className="home-blogs-section-icon" />
              </div>
            </div>
            <div className="home-blogs-collection-wrap">
              <div className="home-blogs-collection-items first-items">
                <div scale-up="True" className="home-blogs-collection-number-box">
                  <img src="/assets/6a997f7f9a9ac716e0665a5d_01.svg" loading="lazy" alt="Number" className="home-blogs-collection-number" />
                </div>
                <div fade-anim="True" className="blogs-collection-wrap w-dyn-list">
                  <div role="list" className="blogs-collection-grid one-grid w-dyn-items">
                    <div role="listitem" className="blogs-collection-items border-none w-dyn-item">
                      <a href="/#how-it-works" className="blogs-collection-box height w-inline-block">
                        <div className="blogs-collection-title-box">
                          <div className="paragraph-small blogs-collection-date">
                            November 2026
                          </div>
                          <div className="blogs-collection-title">
                            The death clock
                          </div>
                        </div>
                        <div className="blogs-collection-content-flex">
                          <div className="paragraph-small blogs-collection-content-category">
                            Hedera
                          </div>
                          <div>
                            <img src="/assets/klero-blog-death-clock.svg" loading="lazy" alt="The death clock" />
                          </div>
                          <div className="paragraph-small blogs-collection-content-text">
                            Hedera rejects a transaction after its valid duration and any id it has already seen, so a payment intent can settle at most once, ever.
                          </div>
                        </div>
                        <div className="display-none">
                          Display None Text
                        </div>
                      </a>
                    </div>
                  </div>
                </div>
              </div>
              <div className="home-blogs-collection-items">
                <div scale-up="True" className="home-blogs-collection-number-box">
                  <img src="/assets/6a997fcade26a0acd007dd60_02.avif" loading="lazy" alt="Number" className="home-blogs-collection-number" />
                </div>
                <div fade-anim="True" className="blogs-collection-wrap w-dyn-list">
                  <div role="list" className="blogs-collection-grid one-grid w-dyn-items">
                    <div role="listitem" className="blogs-collection-items border-none w-dyn-item">
                      <a href="/directory" className="blogs-collection-box height w-inline-block">
                        <div className="blogs-collection-title-box">
                          <div className="paragraph-small blogs-collection-date">
                            November 2026
                          </div>
                          <div className="blogs-collection-title">
                            Why World ID
                          </div>
                        </div>
                        <div className="blogs-collection-content-flex">
                          <div className="paragraph-small blogs-collection-content-category">
                            Identity
                          </div>
                          <div>
                            <img src="/assets/klero-blog-world.svg" loading="lazy" alt="Why World ID" />
                          </div>
                          <div className="paragraph-small blogs-collection-content-text">
                            Every agent links to one real human with World ID, so your Claude agent and your script agent share one budget and one dedupe scope, and only you can approve what is over the cap.
                          </div>
                        </div>
                        <div className="display-none">
                          Display None Text
                        </div>
                      </a>
                    </div>
                  </div>
                </div>
              </div>
            </div>
            <div className="home-blogs-link-box">
              <a href="https://github.com/sylesh7/Klero-1" target="_blank" rel="noreferrer" className="home-blogs-link w-inline-block">
                <div className="home-blogs-link-text">
                  Read the docs
                </div>
              </a>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
