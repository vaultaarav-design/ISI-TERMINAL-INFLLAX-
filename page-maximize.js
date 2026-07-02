// ══════════════════════════════════════════════════════════════════
// PAGE-MAXIMIZE UTILITY — shared by monitoring.html & multicluster.html
// Turns any ".mon-modal" report popup (Strategy Discovery Full Report,
// Cost of Violation & Psychology Full Report) into a full-page view
// with the site's nav header + footer, and a Back button that returns
// to whichever page (Monitoring / Multi Cluster) the report was
// opened from. Purely additive — does not touch existing modal logic.
// ══════════════════════════════════════════════════════════════════
(function () {
    window.__reportMaximize = function (modalId) {
        const modal = document.getElementById(modalId);
        if (!modal) return;
        const content = modal.querySelector('.mon-modal-content');
        const popupHeader = modal.querySelector('.rep-popup-header');
        const maxHeader = modal.querySelector('.rep-max-header');
        const maxFooter = modal.querySelector('.rep-max-footer');
        modal.classList.add('rep-maximized');
        if (content) content.classList.add('rep-maximized');
        if (popupHeader) popupHeader.style.display = 'none';
        if (maxHeader) maxHeader.style.display = 'flex';
        if (maxFooter) maxFooter.style.display = 'block';
        document.body.style.overflow = 'hidden';
        modal.scrollTop = 0;
    };

    // "Back" — exits maximize AND returns to the underlying page
    // (the modal simply closes, revealing the page it was opened from).
    window.__reportMinimize = function (modalId) {
        const modal = document.getElementById(modalId);
        if (!modal) return;
        const content = modal.querySelector('.mon-modal-content');
        const popupHeader = modal.querySelector('.rep-popup-header');
        const maxHeader = modal.querySelector('.rep-max-header');
        const maxFooter = modal.querySelector('.rep-max-footer');
        modal.classList.remove('rep-maximized');
        if (content) content.classList.remove('rep-maximized');
        if (popupHeader) popupHeader.style.display = '';
        if (maxHeader) maxHeader.style.display = 'none';
        if (maxFooter) maxFooter.style.display = 'none';
        document.body.style.overflow = '';
        modal.style.display = 'none';
        // If the cost report's chart fullscreen overlay is open, close that too
        if (window.__costReportExitFS) window.__costReportExitFS();
    };

    document.addEventListener('keydown', function (e) {
        if (e.key !== 'Escape') return;
        document.querySelectorAll('.mon-modal.rep-maximized').forEach(function (m) {
            window.__reportMinimize(m.id);
        });
    });
})();
