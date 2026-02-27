import UserRegistrationHandler from './UserRegistrationHandler.mjs'
import AuthenticationManager from '../Authentication/AuthenticationManager.mjs'

function renderRegisterPage(req, res, extra = {}) {
  const sharedProjectData = req.session.sharedProjectData || {}
  const newTemplateData = {}
  if (req.session.templateData != null) {
    newTemplateData.templateName = req.session.templateData.templateName
  }

  res.render('user/register-public', {
    title: 'register',
    sharedProjectData,
    newTemplateData,
    samlBeta: req.session.samlBeta,
    formError: null,
    sentEmail: null,
    formEmail: '',
    ...extra,
  })
}

async function register(req, res) {
  const email = String(req.body?.email || '').trim()
  const invalidEmail = AuthenticationManager.validateEmail(email)

  if (!email || invalidEmail) {
    return renderRegisterPage(req, res, {
      formError: 'Please enter a valid email address.',
      formEmail: email,
    })
  }

  try {
    await UserRegistrationHandler.promises.registerNewUserAndSendActivationEmail(
      email
    )

    return renderRegisterPage(req, res, {
      sentEmail: email,
      formEmail: email,
    })
  } catch (error) {
    return renderRegisterPage(req, res, {
      formError: 'We could not create the account right now. Please try again.',
      formEmail: email,
    })
  }
}

export default {
  renderRegisterPage,
  register,
}
